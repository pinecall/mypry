// Test fixture: script with various local types for locals testing.
'use strict'

const pry = require('../../lib/pry.cjs')

const aString = 'hello world'
const aNumber = 3.14
const aBoolean = true
const anArray = [1, 2, 3]
const anObject = { name: 'test', nested: { deep: true } }
const aNullValue = null

pry({ port: parseInt(process.env.PRY_PORT || '9231') })

console.log('done', aString, aNumber, aBoolean, anArray, anObject, aNullValue)
