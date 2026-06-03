// Test fixture: simple script with pry() at a known line.
// Used by contract tests to verify ndjson protocol.
'use strict'

const pry = require('../../lib/pry.cjs')

const x = 42
const y = { a: 1, b: 2 }

pry({ port: parseInt(process.env.PRY_PORT || '9230') })

const z = x + 1
console.log('continued past pry, z =', z)
