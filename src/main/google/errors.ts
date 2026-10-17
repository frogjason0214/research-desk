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

export const MISSING_SCOPE_MESSAGE =
  '登入時沒有勾選行事曆權限。請再按一次「登入 Google」，在權限畫面勾選「查看、編輯、共用及永久刪除您可透過 Google 日曆存取的所有日曆」。'
