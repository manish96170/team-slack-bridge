function typeMatches(value, expected) {
  if (Array.isArray(expected)) return expected.some(type => typeMatches(value, type))
  if (expected === 'array') return Array.isArray(value)
  if (expected === 'object') return !!value && typeof value === 'object' && !Array.isArray(value)
  return typeof value === expected
}

function validateValue(value, schema, path) {
  if (!schema) return null
  if (schema.type && !typeMatches(value, schema.type)) {
    const expected = Array.isArray(schema.type) ? schema.type.join('|') : schema.type
    return `${path} must be ${expected}`
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return `${path} must be one of: ${schema.enum.join(', ')}`
  }
  if (schema.type === 'array' && schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const itemError = validateValue(value[i], schema.items, `${path}[${i}]`)
      if (itemError) return itemError
    }
  }
  return null
}

export function validateArguments(schema, args = {}) {
  if (!schema || schema.type !== 'object') return null
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object'

  for (const required of schema.required || []) {
    if (!(required in args)) return `missing required argument: ${required}`
  }

  // `x-linkProvides` (mcp/links.js): arguments a Slack permalink can supply,
  // so they are only required when no `link` was passed.
  for (const key of schema['x-linkProvides'] || []) {
    if (!(key in args) && !('link' in args)) return `missing required argument: ${key} (or pass link)`
  }

  const properties = schema.properties || {}
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in properties)) return `unknown argument: ${key}`
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const error = validateValue(value, properties[key], key)
    if (error) return error
  }

  return null
}
