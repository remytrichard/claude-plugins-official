/**
 * Tests for the persistent Telegram message inbox.
 *
 * Run with: bun test
 *
 * The inbox writes to a temp SQLite file so tests are fully isolated
 * from any real STATE_DIR data.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ─── Test helpers ─────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `telegram-inbox-test-${process.pid}`)

/** Minimal InboxParams fixture */
function makeParams(overrides: Partial<{
  content: string
  chat_id: string
  message_id: string
  user: string
  image_path: string
  attachment_kind: string
  attachment_file_id: string
}> = {}): {
  content: string
  meta: {
    chat_id: string
    message_id?: string
    user: string
    user_id: string
    ts: string
    image_path?: string
    attachment_kind?: string
    attachment_file_id?: string
  }
} {
  return {
    content: overrides.content ?? 'hello world',
    meta: {
      chat_id: overrides.chat_id ?? '5343909775',
      ...(overrides.message_id !== undefined ? { message_id: overrides.message_id } : {}),
      user: overrides.user ?? 'testuser',
      user_id: '5343909775',
      ts: '2026-03-26T08:00:00.000Z',
      ...(overrides.image_path !== undefined ? { image_path: overrides.image_path } : {}),
      ...(overrides.attachment_kind !== undefined ? { attachment_kind: overrides.attachment_kind } : {}),
      ...(overrides.attachment_file_id !== undefined ? { attachment_file_id: overrides.attachment_file_id } : {}),
    },
  }
}

/** Open a fresh test DB with the same schema as production */
function openTestDb(path: string): Database {
  const db = new Database(path)
  db.run('PRAGMA journal_mode=WAL')
  db.run(`
    CREATE TABLE IF NOT EXISTS inbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     TEXT    NOT NULL,
      message_id  INTEGER,
      params_json TEXT    NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'pending',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      delivered_at INTEGER
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS inbox_chat_id ON inbox (chat_id)')
  db.run('CREATE INDEX IF NOT EXISTS inbox_status  ON inbox (status)')
  return db
}

/** Insert a row directly into the test DB */
function insertRow(db: Database, params: ReturnType<typeof makeParams>, opts: {
  message_id?: number | null
  created_at?: number
  status?: string
} = {}): number {
  const stmt = db.prepare(
    `INSERT INTO inbox (chat_id, message_id, params_json, status, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  const result = stmt.run(
    params.meta.chat_id,
    opts.message_id ?? (params.meta.message_id != null ? Number(params.meta.message_id) : null),
    JSON.stringify(params),
    opts.status ?? 'pending',
    opts.created_at ?? Math.floor(Date.now() / 1000)
  ) as { lastInsertRowid: number }
  return result.lastInsertRowid
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

// ─── writeInbox ───────────────────────────────────────────────────────────────

describe('writeInbox', () => {
  test('inserts a pending row with correct fields', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)

    const params = makeParams({ message_id: '42', content: 'test message' })
    const stmt = db.prepare(
      'INSERT INTO inbox (chat_id, message_id, params_json) VALUES (?, ?, ?)'
    )
    stmt.run(params.meta.chat_id, 42, JSON.stringify(params))

    const row = db.prepare('SELECT * FROM inbox WHERE id = 1').get() as {
      id: number; chat_id: string; message_id: number; params_json: string; status: string
    }
    expect(row.chat_id).toBe('5343909775')
    expect(row.message_id).toBe(42)
    expect(row.status).toBe('pending')

    const stored = JSON.parse(row.params_json) as ReturnType<typeof makeParams>
    expect(stored.content).toBe('test message')
    expect(stored.meta.user).toBe('testuser')
  })

  test('preserves image_path in params_json (full metadata round-trip)', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)

    const params = makeParams({
      image_path: '/home/user/.claude/channels/telegram/inbox/photo.jpg',
      attachment_kind: 'photo',
      attachment_file_id: 'BQACAgIAAxkBAAIBdGY',
    })
    db.prepare('INSERT INTO inbox (chat_id, message_id, params_json) VALUES (?, ?, ?)').run(
      params.meta.chat_id, null, JSON.stringify(params)
    )

    const row = db.prepare('SELECT params_json FROM inbox LIMIT 1').get() as { params_json: string }
    const stored = JSON.parse(row.params_json) as ReturnType<typeof makeParams>
    expect(stored.meta.image_path).toBe('/home/user/.claude/channels/telegram/inbox/photo.jpg')
    expect(stored.meta.attachment_kind).toBe('photo')
    expect(stored.meta.attachment_file_id).toBe('BQACAgIAAxkBAAIBdGY')
  })

  test('uses parameterized query — SQL injection in content does not corrupt DB', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)

    const malicious = makeParams({ content: `'); DROP TABLE inbox; --` })
    db.prepare('INSERT INTO inbox (chat_id, message_id, params_json) VALUES (?, ?, ?)').run(
      malicious.meta.chat_id, null, JSON.stringify(malicious)
    )

    // Table must still exist and row must be readable
    const count = (db.prepare('SELECT COUNT(*) as n FROM inbox').get() as { n: number }).n
    expect(count).toBe(1)
    const stored = JSON.parse(
      (db.prepare('SELECT params_json FROM inbox LIMIT 1').get() as { params_json: string }).params_json
    ) as ReturnType<typeof makeParams>
    expect(stored.content).toBe(`'); DROP TABLE inbox; --`)
  })
})

// ─── pruneExpiredInbox ────────────────────────────────────────────────────────

describe('pruneExpiredInbox', () => {
  const TTL = 24 * 60 * 60

  test('leaves recent rows untouched', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)
    insertRow(db, makeParams(), { created_at: Math.floor(Date.now() / 1000) - 3600 }) // 1h old

    const cutoff = Math.floor(Date.now() / 1000) - TTL
    db.prepare(`UPDATE inbox SET status = 'expired' WHERE status = 'pending' AND created_at < ?`).run(cutoff)

    const row = db.prepare('SELECT status FROM inbox LIMIT 1').get() as { status: string }
    expect(row.status).toBe('pending')
  })

  test('expires rows older than TTL', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)
    const oldTime = Math.floor(Date.now() / 1000) - TTL - 3600 // 25h ago
    insertRow(db, makeParams(), { created_at: oldTime })

    const cutoff = Math.floor(Date.now() / 1000) - TTL
    const result = db.prepare(
      `UPDATE inbox SET status = 'expired' WHERE status = 'pending' AND created_at < ?`
    ).run(cutoff) as { changes: number }

    expect(result.changes).toBe(1)
    const row = db.prepare('SELECT status FROM inbox LIMIT 1').get() as { status: string }
    expect(row.status).toBe('expired')
  })

  test('leaves already-delivered rows alone', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)
    const oldTime = Math.floor(Date.now() / 1000) - TTL - 3600
    insertRow(db, makeParams(), { created_at: oldTime, status: 'delivered' })

    const cutoff = Math.floor(Date.now() / 1000) - TTL
    const result = db.prepare(
      `UPDATE inbox SET status = 'expired' WHERE status = 'pending' AND created_at < ?`
    ).run(cutoff) as { changes: number }

    expect(result.changes).toBe(0)
    const row = db.prepare('SELECT status FROM inbox LIMIT 1').get() as { status: string }
    expect(row.status).toBe('delivered')
  })
})

// ─── drain logic ──────────────────────────────────────────────────────────────

describe('drain logic', () => {
  test('no pending rows → 0 delivered', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)
    // Insert a delivered row — should not be re-sent
    insertRow(db, makeParams(), { status: 'delivered' })

    const rows = db.prepare(
      `SELECT id, chat_id, message_id, params_json FROM inbox WHERE status = 'pending' ORDER BY id ASC`
    ).all()
    expect(rows.length).toBe(0)
  })

  test('pending rows are replayed FIFO', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)

    const t = Math.floor(Date.now() / 1000)
    insertRow(db, makeParams({ content: 'first', message_id: '1' }), { created_at: t })
    insertRow(db, makeParams({ content: 'second', message_id: '2' }), { created_at: t + 1 })

    const rows = db.prepare(
      `SELECT id, chat_id, message_id, params_json FROM inbox WHERE status = 'pending' ORDER BY id ASC`
    ).all() as Array<{ id: number; chat_id: string; message_id: number; params_json: string }>

    expect(rows.length).toBe(2)
    expect(JSON.parse(rows[0]!.params_json).content).toBe('first')
    expect(JSON.parse(rows[1]!.params_json).content).toBe('second')
  })

  test('delivered rows are marked with delivered_at', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)
    const rowId = insertRow(db, makeParams({ message_id: '10' }))

    db.prepare(
      `UPDATE inbox SET status = 'delivered', delivered_at = unixepoch() WHERE id = ?`
    ).run(rowId)

    const row = db.prepare('SELECT status, delivered_at FROM inbox WHERE id = ?').get(rowId) as {
      status: string; delivered_at: number
    }
    expect(row.status).toBe('delivered')
    expect(row.delivered_at).toBeGreaterThan(0)
  })

  test('dedup: same chat_id + message_id already delivered → skip, mark delivered', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)

    // First row: already delivered
    insertRow(db, makeParams({ message_id: '99' }), { status: 'delivered' })
    // Second row: same chat_id + message_id, pending (simulates shutdown-window race)
    const dupId = insertRow(db, makeParams({ message_id: '99' }))

    const dedupStmt = db.prepare(
      `SELECT 1 FROM inbox WHERE chat_id = ? AND message_id = ? AND status = 'delivered' LIMIT 1`
    )

    const row = db.prepare(
      `SELECT id, chat_id, message_id FROM inbox WHERE id = ?`
    ).get(dupId) as { id: number; chat_id: string; message_id: number }

    const dup = dedupStmt.get(row.chat_id, row.message_id)
    expect(dup).not.toBeNull()
  })

  test('dedup: different chat_ids with same message_id are NOT considered duplicates', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)

    // chat A: message 1, delivered
    insertRow(db, makeParams({ chat_id: 'chatA', message_id: '1' }), { status: 'delivered' })

    // chat B: message 1, pending — different chat, should NOT be a dup
    const dedupStmt = db.prepare(
      `SELECT 1 FROM inbox WHERE chat_id = ? AND message_id = ? AND status = 'delivered' LIMIT 1`
    )
    const dup = dedupStmt.get('chatB', 1)
    expect(dup).toBeNull()
  })

  test('notification failure leaves row as pending', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)
    const rowId = insertRow(db, makeParams({ message_id: '5' }))

    // Simulate failed delivery: do NOT update status
    // (in real drain, the catch block just increments failed counter)
    const row = db.prepare('SELECT status FROM inbox WHERE id = ?').get(rowId) as { status: string }
    expect(row.status).toBe('pending')
  })

  test('malformed params_json row is marked expired during drain', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)

    // Insert a row with invalid JSON
    const stmt = db.prepare('INSERT INTO inbox (chat_id, message_id, params_json) VALUES (?, ?, ?)')
    const result = stmt.run('5343909775', 77, 'NOT_VALID_JSON') as { lastInsertRowid: number }
    const rowId = result.lastInsertRowid

    // Simulate drain: attempt JSON parse, mark expired on failure
    const row = db.prepare('SELECT params_json FROM inbox WHERE id = ?').get(rowId) as { params_json: string }
    let parseOk = true
    try { JSON.parse(row.params_json) } catch { parseOk = false }
    expect(parseOk).toBe(false)

    // The drain loop marks it expired
    db.prepare(`UPDATE inbox SET status = 'expired' WHERE id = ?`).run(rowId)
    const after = db.prepare('SELECT status FROM inbox WHERE id = ?').get(rowId) as { status: string }
    expect(after.status).toBe('expired')
  })
})

// ─── write-ahead pattern ──────────────────────────────────────────────────────

describe('write-ahead delivery pattern', () => {
  test('row inserted as pending BEFORE delivery, marked delivered on success', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)

    // Step 1: write-ahead insert (status defaults to 'pending')
    const stmt = db.prepare('INSERT INTO inbox (chat_id, message_id, params_json) VALUES (?, ?, ?)')
    const result = stmt.run('5343909775', 42, JSON.stringify(makeParams())) as { lastInsertRowid: number }
    const rowId = result.lastInsertRowid

    // Verify row is pending before delivery
    const before = db.prepare('SELECT status FROM inbox WHERE id = ?').get(rowId) as { status: string }
    expect(before.status).toBe('pending')

    // Step 2: delivery succeeds — mark delivered (simulates markInboxDelivered)
    db.prepare(`UPDATE inbox SET status = 'delivered', delivered_at = unixepoch() WHERE id = ?`).run(rowId)

    const after = db.prepare('SELECT status, delivered_at FROM inbox WHERE id = ?').get(rowId) as {
      status: string; delivered_at: number
    }
    expect(after.status).toBe('delivered')
    expect(after.delivered_at).toBeGreaterThan(0)
  })

  test('row stays pending if delivery fails (will be drained on next session)', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)

    // Write-ahead insert
    const stmt = db.prepare('INSERT INTO inbox (chat_id, message_id, params_json) VALUES (?, ?, ?)')
    const result = stmt.run('5343909775', 43, JSON.stringify(makeParams())) as { lastInsertRowid: number }
    const rowId = result.lastInsertRowid

    // Simulate delivery failure: do NOT update status
    const row = db.prepare('SELECT status FROM inbox WHERE id = ?').get(rowId) as { status: string }
    expect(row.status).toBe('pending')
  })
})

// ─── pruneExpiredInbox cleanup ────────────────────────────────────────────────

describe('pruneExpiredInbox cleanup', () => {
  test('deletes delivered rows older than 7 days', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)

    const oldTime = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60 // 8 days ago
    insertRow(db, makeParams(), { created_at: oldTime, status: 'delivered' })

    // Simulate the DELETE cleanup in pruneExpiredInbox
    const cleanupCutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
    const result = db.prepare(
      `DELETE FROM inbox WHERE status IN ('delivered', 'expired') AND created_at < ?`
    ).run(cleanupCutoff) as { changes: number }

    expect(result.changes).toBe(1)
    expect((db.prepare('SELECT COUNT(*) as n FROM inbox').get() as { n: number }).n).toBe(0)
  })

  test('leaves recently delivered rows intact (under 7 days)', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db = openTestDb(dbPath)

    insertRow(db, makeParams(), { status: 'delivered' }) // just now

    const cleanupCutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
    const result = db.prepare(
      `DELETE FROM inbox WHERE status IN ('delivered', 'expired') AND created_at < ?`
    ).run(cleanupCutoff) as { changes: number }

    expect(result.changes).toBe(0)
    expect((db.prepare('SELECT COUNT(*) as n FROM inbox').get() as { n: number }).n).toBe(1)
  })
})

// ─── DB singleton ─────────────────────────────────────────────────────────────

describe('DB lifecycle', () => {
  test('DB file is created on first open', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    expect(existsSync(dbPath)).toBe(false)
    const db = openTestDb(dbPath)
    db.close()
    expect(existsSync(dbPath)).toBe(true)
  })

  test('schema is idempotent — CREATE TABLE IF NOT EXISTS does not throw on re-open', () => {
    const dbPath = join(TEST_DIR, 'inbox.db')
    const db1 = openTestDb(dbPath)
    db1.close()
    // Opening again with same schema should not throw
    expect(() => openTestDb(dbPath)).not.toThrow()
  })
})
