const NO_BODY_STATUSES = new Set([204, 205, 304])

export const statusAllowsBody = (status: number) => status >= 200 && !NO_BODY_STATUSES.has(status)
