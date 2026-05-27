import { useState, useCallback } from 'react'
import { pry } from 'mypry/browser'
import './App.css'

// ── Types ───

interface User {
  id: number
  name: string
  email: string
  role: string
}

interface Order {
  id: number
  userId: number
  user: string
  items: string[]
  total: number
  status: string
  createdAt: string
}

type LogEntry = { time: string; text: string; type: 'info' | 'success' | 'error' | 'paused-backend' | 'paused-frontend' }

const API = 'http://localhost:3456'

// ── App ───

function App() {
  const [users, setUsers] = useState<User[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState<string | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])

  const addLog = useCallback((text: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString()
    setLog(prev => [{ time, text, type }, ...prev].slice(0, 80))
  }, [])

  // ── Fetch Users ───

  const fetchUsers = async () => {
    setLoading('Fetching users...')
    const params = searchQuery ? `?search=${encodeURIComponent(searchQuery)}` : ''
    addLog(`→ GET /api/users${params}`)
    addLog('⏸ Backend will pause at pry() — use mypry CLI to continue', 'paused-backend')

    try {
      const res = await fetch(`${API}/api/users${params}`)
      const data = await res.json()

      // 🔮 FRONTEND PRY — sends state to mypry via Express
      pry({ message: `fetchUsers: ${data.count} users` })

      setUsers(data.users)
      addLog(`✅ Got ${data.count} users`, 'success')
      addLog('🔮 Frontend pry() sent to mypry', 'paused-frontend')
    } catch (e: any) {
      addLog(`❌ ${e.message}`, 'error')
    }
    setLoading(null)
  }

  // ── Fetch Single User ───

  const fetchUser = async (id: number) => {
    setLoading(`Fetching user #${id}...`)
    addLog(`→ GET /api/users/${id}`)
    addLog('⏸ Backend will pause at pry()', 'paused-backend')

    try {
      const res = await fetch(`${API}/api/users/${id}`)
      const user = await res.json()

      // 🔮 FRONTEND PRY — sends user data to mypry
      pry({ message: `fetchUser #${id}: ${user.name}` })

      setSelectedUser(user)
      addLog(`✅ Got user: ${user.name}`, 'success')
      addLog('🔮 Frontend pry() sent to mypry', 'paused-frontend')
    } catch (e: any) {
      addLog(`❌ ${e.message}`, 'error')
    }
    setLoading(null)
  }

  // ── Create Order ───

  const createOrder = async (userId: number) => {
    const items = ['Widget', 'Gadget', 'Doohickey'].slice(0, Math.floor(Math.random() * 3) + 1)
    setLoading('Creating order...')
    addLog(`→ POST /api/orders { userId: ${userId}, items: [${items.join(', ')}] }`)
    addLog('⏸ Backend will pause at pry()', 'paused-backend')

    try {
      const res = await fetch(`${API}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, items }),
      })
      const order = await res.json()

      // 🔮 FRONTEND PRY — sends order data to mypry
      pry({ message: `createOrder #${order.id}` })

      setOrders(prev => [order, ...prev])
      addLog(`✅ Order #${order.id} — $${order.total.toFixed(2)}`, 'success')
      addLog('🔮 Frontend pry() sent to mypry', 'paused-frontend')
    } catch (e: any) {
      addLog(`❌ ${e.message}`, 'error')
    }
    setLoading(null)
  }

  // ── Fetch Orders ───

  const fetchOrders = async () => {
    setLoading('Fetching orders...')
    addLog('→ GET /api/orders')
    try {
      const res = await fetch(`${API}/api/orders`)
      const data = await res.json()

      // 🔮 FRONTEND PRY
      pry({ message: `fetchOrders: ${data.count} orders` })

      setOrders(data.orders)
      addLog(`✅ Got ${data.count} orders`, 'success')
    } catch (e: any) {
      addLog(`❌ ${e.message}`, 'error')
    }
    setLoading(null)
  }

  // ── Render ───

  return (
    <div className="app">
      <header>
        <div className="logo">🔮</div>
        <div className="header-text">
          <h1>mypry <span className="accent">fullstack</span> demo</h1>
          <p className="subtitle">
            Backend + Frontend <code>pry()</code> — both pause in <strong>mypry CLI</strong>
          </p>
        </div>
      </header>

      {loading && (
        <div className="loading-banner">
          <div className="spinner" />
          <span>{loading}</span>
        </div>
      )}

      <div className="grid">
        {/* ── Users Panel ── */}
        <section className="panel">
          <div className="panel-header">
            <h2>👤 Users</h2>
            <button onClick={fetchUsers} disabled={!!loading}>Load</button>
          </div>
          <div className="search-bar">
            <input
              type="text"
              placeholder="Search by name or email..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && fetchUsers()}
            />
          </div>
          <div className="list">
            {users.map(u => (
              <div
                key={u.id}
                className={`list-item ${selectedUser?.id === u.id ? 'active' : ''}`}
                onClick={() => fetchUser(u.id)}
              >
                <div className="list-item-top">
                  <span className="name">{u.name}</span>
                  <span className={`badge ${u.role}`}>{u.role}</span>
                </div>
                <span className="email">{u.email}</span>
                <button
                  className="btn-small"
                  onClick={e => { e.stopPropagation(); createOrder(u.id) }}
                  disabled={!!loading}
                >
                  + Order
                </button>
              </div>
            ))}
            {users.length === 0 && (
              <div className="empty">Click "Load" to fetch from the Express API</div>
            )}
          </div>
        </section>

        {/* ── Orders Panel ── */}
        <section className="panel">
          <div className="panel-header">
            <h2>📦 Orders</h2>
            <button onClick={fetchOrders} disabled={!!loading}>Refresh</button>
          </div>
          <div className="list">
            {orders.map(o => (
              <div key={o.id} className="list-item">
                <div className="list-item-top">
                  <span className="name">Order #{o.id}</span>
                  <span className={`badge ${o.status}`}>{o.status}</span>
                </div>
                <span className="email">{o.user} — {o.items.join(', ')} — ${o.total.toFixed(2)}</span>
              </div>
            ))}
            {orders.length === 0 && (
              <div className="empty">No orders yet</div>
            )}
          </div>
        </section>

        {/* ── Log Panel ── */}
        <section className="panel log-panel">
          <div className="panel-header">
            <h2>📋 Debug Log</h2>
            <button onClick={() => setLog([])} disabled={log.length === 0}>Clear</button>
          </div>
          <div className="log">
            {log.map((entry, i) => (
              <div key={i} className={`log-entry ${entry.type}`}>
                <span className="log-time">{entry.time}</span>
                <span className="log-text">{entry.text}</span>
              </div>
            ))}
            {log.length === 0 && (
              <div className="empty">Click buttons to see requests & pry() pauses</div>
            )}
          </div>
        </section>
      </div>

      <footer>
        <div className="how-to">
          <h3>How it works</h3>
          <div className="steps">
            <div className="step backend">
              <div className="step-num">1</div>
              <div>
                <code>node examples/fullstack/server/index.js</code>
                <p>Express server with <code>pry()</code> in every route</p>
              </div>
            </div>
            <div className="step backend">
              <div className="step-num">2</div>
              <div>
                <code>mypry attach</code>
                <p>Attach to backend — step, eval, continue</p>
              </div>
            </div>
            <div className="step frontend">
              <div className="step-num">3</div>
              <div>
                <code>cd examples/fullstack/client && npm run dev</code>
                <p>React app — frontend <code>pry()</code> sends state to mypry too</p>
              </div>
            </div>
            <div className="step frontend">
              <div className="step-num">4</div>
              <div>
                <code>browserState</code>
                <p>In mypry REPL, inspect frontend data sent by browser pry()</p>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default App
