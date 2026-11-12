// Only hashes of browser bearer tokens are stored. The CSRF nonce is not a login
// credential and still requires the HttpOnly cookie and exact same-origin checks.
export class AdminSessions extends Map {
  constructor(db, binding) {
    super(); this.db=db; this.binding=binding
    for (const row of db.prepare("SELECT key,value FROM hub_management WHERE key GLOB 'adminSession:*' ORDER BY rowid").all()) {
      let value
      try { value=JSON.parse(row.value) } catch { /* Discard corrupt login state. */ }
      if (value?.binding===binding && typeof value.csrf==='string') super.set(row.key.slice('adminSession:'.length),value)
      else db.prepare('DELETE FROM hub_management WHERE key=?').run(row.key)
    }
  }
  set(key,value) {
    const saved={...value,binding:this.binding}
    this.db.prepare('INSERT INTO hub_management VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('adminSession:'+key,JSON.stringify(saved))
    return super.set(key,saved)
  }
  delete(key) { this.db.prepare('DELETE FROM hub_management WHERE key=?').run('adminSession:'+key);return super.delete(key) }
  clear() { this.db.prepare("DELETE FROM hub_management WHERE key GLOB 'adminSession:*'").run();super.clear() }
  detach() { super.clear() }
}
