'use strict'
// Test fixture: main + worker thread for worker debugging
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads')

if (isMainThread) {
  console.log('[main] starting worker')
  const worker = new Worker(__filename, { workerData: { items: ['alice', 'bob', 'admin'] } })
  worker.on('message', m => console.log('[main] from worker:', m))
  worker.on('exit', () => { console.log('[main] worker exited'); process.exit(0) })
} else {
  // Worker thread
  const items = workerData.items
  for (const item of items) {
    const result = item.toUpperCase()
    debugger  // ← pause in worker
    parentPort.postMessage({ item, result })
  }
}
