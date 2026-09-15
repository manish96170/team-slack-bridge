import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripMentionPrefix } from '../listen/socket.js'

test('stripMentionPrefix removes the leading <@BOTID> Slack always prepends to app_mention text', () => {
  assert.equal(stripMentionPrefix('<@U0BOT123> start session fix the bug'), 'start session fix the bug')
})

test('stripMentionPrefix tolerates extra whitespace after the mention', () => {
  assert.equal(stripMentionPrefix('<@U0BOT123>   start session fix the bug'), 'start session fix the bug')
})

test('stripMentionPrefix leaves text unchanged when there is no mention prefix', () => {
  assert.equal(stripMentionPrefix('start session fix the bug'), 'start session fix the bug')
})

test('stripMentionPrefix handles empty/undefined input without throwing', () => {
  assert.equal(stripMentionPrefix(''), '')
  assert.equal(stripMentionPrefix(undefined), '')
})
