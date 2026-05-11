import { describe, expect, it } from 'vitest'
import packageJson from '../package.json'
import { MOS_PROXY_PACKAGE_VERSION } from '../src/apiRequestHeaders'

describe('apiRequestHeaders', () => {
    it('uses the package.json version as the API request version header value', () => {
        expect(MOS_PROXY_PACKAGE_VERSION).toBe(packageJson.version)
    })
})
