import { useEffect, useRef, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { authApi } from '@/services/api'

/**
 * 중앙 SSO 허브(auth.nuldam.com)에서 돌아오는 콜백 페이지.
 * URL 프래그먼트(#token=...)로 전달된 허브 JWT를 백엔드에 교환 요청하여
 * 이 앱 자체의 access/refresh 토큰을 받아, 기존 OTP 로그인과 동일한 방식으로
 * Zustand authStore에 세션을 저장한다.
 */
export default function SsoPage() {
  const navigate = useNavigate()
  const login = useAuthStore((state) => state.login)
  const [status, setStatus] = useState<'loading' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState('')
  const ranRef = useRef(false)

  useEffect(() => {
    // StrictMode 이중 실행/중복 토큰 교환 방지
    if (ranRef.current) return
    ranRef.current = true

    const hash = window.location.hash
    const match = hash.match(/token=([^&]+)/)
    const token = match ? decodeURIComponent(match[1]) : null

    // URL에서 토큰 흔적 제거 (히스토리/새로고침 시 재노출 방지)
    if (hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }

    if (!token) {
      setStatus('error')
      setErrorMessage('인증 토큰을 찾을 수 없습니다. SSO 로그인을 다시 시도해 주세요.')
      return
    }

    authApi
      .sso(token)
      .then((response) => {
        const result = response.data

        login(
          {
            id: result.user.id,
            employeeId: result.user.employee_id,
            email: result.user.email,
            username: result.user.username,
            fullName: result.user.full_name,
            departmentId: result.user.department_id,
            departmentName: result.user.department_name,
            roleId: result.user.role_id,
            roleName: result.user.role_name,
            position: result.user.position,
            isAdmin: !!result.user.is_admin,
          },
          result.access_token,
          result.refresh_token
        )

        navigate(result.user.is_admin ? '/dashboard' : '/my-cards', { replace: true })
      })
      .catch((error) => {
        const status = error?.response?.status
        const message =
          status === 401 || status === 403
            ? '회사 계정 인증에 실패했습니다. 접근 권한이 없거나 세션이 만료되었습니다.'
            : error?.response?.data?.detail || 'SSO 로그인 처리 중 오류가 발생했습니다.'
        setStatus('error')
        setErrorMessage(message)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-600 dark:from-blue-400 to-indigo-800 dark:to-indigo-200">
      <div className="max-w-md w-full mx-4">
        <div className="bg-white dark:bg-ink-900 rounded-2xl shadow-xl overflow-hidden p-8 text-center">
          {status === 'loading' ? (
            <>
              <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-gray-200 dark:border-ink-800 border-t-blue-600" />
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">회사 계정으로 로그인 중...</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">잠시만 기다려 주세요</p>
            </>
          ) : (
            <>
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-red-100 dark:bg-red-900 mb-3">
                <svg className="w-7 h-7 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">로그인 실패</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">{errorMessage}</p>
              <Link
                to="/login"
                className="inline-block mt-6 w-full bg-gradient-to-r from-blue-600 dark:from-blue-400 to-indigo-600 dark:to-indigo-400 text-white py-3 rounded-lg font-medium hover:from-blue-700 hover:to-indigo-700 transition-all"
              >
                로그인 화면으로 돌아가기
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
