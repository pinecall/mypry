'use strict'

const pry = require('../lib/pry.cjs')

// ── Hello World con mypry ──

function greet(name) {
  const greeting = `Hello, ${name}!`
  const uppercased = greeting.toUpperCase()

  pry()  // ← pausa acá, podés inspeccionar greeting, uppercased, name

  return uppercased
}

function main() {
  const names = ['World', 'mypry', 'Debugger']
  const results = []

  for (const name of names) {
    const result = greet(name)
    results.push(result)
    console.log(result)
  }

  console.log('All greetings:', results)
}

main()
