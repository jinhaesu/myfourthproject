import { useEffect } from 'react'

// 통합 SSO 자동 전환 로그인 페이지
// 로그인 페이지 진입 즉시 중앙 허브(auth.nuldam.com)로 자동 이동해 구글 로그인 수행.
// 이메일 OTP 폼/버튼 없음. (/sso 콜백 페이지는 SsoPage.tsx 에서 처리)
export default function LoginPage() {
  useEffect(() => {
    const returnUrl = encodeURIComponent('https://account.nuldam.com/sso')
    window.location.href = `https://auth.nuldam.com/authorize?app=account&return=${returnUrl}`
  }, [])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-blue-600 dark:from-blue-400 to-indigo-800 dark:to-indigo-200 text-white">
      <div className="w-10 h-10 border-4 border-white/30 border-t-white rounded-full animate-spin mb-5" />
      <p className="text-base font-medium">회사 계정 로그인으로 이동 중...</p>
    </div>
  )
}
