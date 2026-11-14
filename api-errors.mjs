export class ApiError extends Error {
  constructor(status, endpoint) { super(`Prove2.me HTTP ${status} at ${endpoint}`); this.status = status; }
}

export const transientReadError = error => error instanceof ApiError
  ? [429, 500, 502, 503, 504].includes(error.status)
  : error?.name === 'TimeoutError' || error instanceof TypeError && error.message === 'fetch failed';
