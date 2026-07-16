import { describe, expect, it } from 'vitest'
import { normalizeClientIP } from '../src/adapters/ClientIPProvider'

describe('normalizeClientIP', () => {
    it.each([
        { input: '203.0.113.42', output: '203.0.113.42' },
        { input: null, output: undefined },
        { input: undefined, output: undefined },
        { input: '', output: undefined },
    ])('normalizes $input to $output', ({ input, output }) => {
        expect(normalizeClientIP(input)).toBe(output)
    })
})
