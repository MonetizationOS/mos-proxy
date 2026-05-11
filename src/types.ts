export type PageMetadata = Record<string, string>

export interface FeatureMeterableProperty {
    type: 'meterable'
    hasAccess: boolean
    remainingUnits?: number
}

export interface FeatureNumberProperty {
    type: 'number'
    value: number
}

export interface Feature {
    featureSlug: string
    properties: Record<string, FeatureMeterableProperty | FeatureNumberProperty>
    sideEffects: unknown[]
}

export interface SubSurfaceMetadataApi {
    cssSelector?: string | null
}

export type SetHttpResponse = {
    headers?: Record<string, string>
    cookies?: string[]
    status: number
    statusText?: string
    body: string | null
}

export type ModifyHttpResponse = {
    addHeaders?: { name: string; value: string }[]
    removeHeaders?: string[]
    addCookies?: string[]
    status?: number
    statusText?: string
    body?: string | null
}

export type SurfaceBehaviorApi = {
    http?: ModifyHttpResponse | SetHttpResponse
    properties?: Record<string, unknown>
} & Record<string, unknown>

export type WebComponentElement<T = Record<string, unknown>> = {
    schema: string
    props: T
}

export type WebElement =
    | {
          type: 'html'
          content: string
      }
    | {
          type: 'text'
          content: string
      }
    | ({
          type: 'element'
      } & WebComponentElement)
    | ({
          type: 'custom'
      } & Record<string, unknown>)

export type WebComponentRangeReplacement = {
    fromMarker?: string
    toMarker?: string
    replaceWith?: WebElement[] | null
}

export type WebContentSurfaceBehavior = {
    before?: WebElement[]
    prepend?: WebElement[]
    remove?: boolean
    replaceRange?: WebComponentRangeReplacement | null
    append?: WebElement[]
    after?: WebElement[]
}

export type SubSurfaceBehaviorApi = {
    content?: WebContentSurfaceBehavior
    properties?: Record<string, unknown>
    metadata: SubSurfaceMetadataApi
} & Record<string, unknown>

export interface SurfaceDecisionResponse {
    status: 'success'
    identity: {
        identifier: string
        isAuthenticated: boolean
        authType: string
        jwtClaims: Record<string, unknown>
    }
    features: Record<string, Feature>
    customer: {
        hasProducts: boolean
    }
    surfaceBehavior: SurfaceBehaviorApi
    componentsSkipped: boolean
    componentBehaviors: Record<string, SubSurfaceBehaviorApi>
}

export interface SurfaceDecisionError {
    message: string
    status: 'error'
    statusCode: number
}

export interface MOSConfigInput {
    /** Origin website base URL, e.g. `https://news.example.com`. */
    originUrl: string
    /** Surface slug identifying the MonetizationOS surface. */
    surfaceSlug: string
    /** MonetizationOS API base URL. */
    mosHost: string
    /** MonetizationOS secret key; expected format `sk_<env>_<suffix>` */
    mosSecretKey: string
    /** Path prefix routed to the MonetizationOS endpoint proxy. Default: `/mos-endpoints/`. */
    mosEndpointsPrefix?: string
    /** Cookie name storing the anonymous session id. */
    anonymousSessionCookieName: string
    /** Cookie name storing the authenticated user JWT. */
    authenticatedUserJwtCookieName: string
    /** Optional script URL injected into the `<head>` of HTML responses. */
    injectScriptUrl?: string
    /** Comma-separated regex patterns; matching pathnames skip surface decisions. */
    surfaceDecisionsIgnorePaths?: string
    /** Optional headers added to or replacing client headers on every origin request. */
    originRequestHeaders?: Record<string, string>
}
