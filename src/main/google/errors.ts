export class AuthExpiredError extends Error {
  constructor() {
    super('Google 登入已過期，請重新登入。')
  }
}

export class GoogleApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}
