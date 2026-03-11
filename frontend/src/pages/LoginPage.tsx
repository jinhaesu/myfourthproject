import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuthStore } from '@/store/authStore'
import { authApi } from '@/services/api'
import { EnvelopeIcon } from '@heroicons/react/24/outline'

export default function LoginPage() {
  const navigate = useNavigate()
  const login = useAuthStore((state) => state.login)

  const [step, setStep] = useState<'email' | 'otp'>('email')
  const [email, setEmail] = useState('')
  const [emailHint, setEmailHint] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [countdown, setCountdown] = useState(0)

  // 카운트다운 타이머
  useEffect(() => {
    if (countdown <= 0) return
    const timer = setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? 0 : prev - 1))
    }, 1000)
    return () => clearInterval(timer)
  }, [countdown])

  // 이메일 제출 → OTP 발송
  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) {
      toast.error('이메일을 입력하세요')
      return
    }

    setIsLoading(true)
    try {
      const response = await authApi.login(email)
      setEmailHint(response.data.email_hint || '')
      setStep('otp')
      setCountdown(300) // 5분
      toast.success('인증 코드가 이메일로 전송되었습니다')
    } catch (error: any) {
      const message = error.response?.data?.detail || '이메일 인증에 실패했습니다'
      toast.error(message)
    } finally {
      setIsLoading(false)
    }
  }

  // OTP 제출 → 로그인
  const handleOtpSubmit = async () => {
    if (otpCode.length !== 6) {
      toast.error('6자리 인증 코드를 입력하세요')
      return
    }

    setIsLoading(true)
    try {
      const response = await authApi.verifyOtp(email, otpCode)
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
        },
        result.access_token,
        result.refresh_token
      )

      toast.success('로그인 성공')
      navigate('/dashboard')
    } catch (error: any) {
      const message = error.response?.data?.detail || 'OTP 인증에 실패했습니다'
      toast.error(message)
      setOtpCode('')
    } finally {
      setIsLoading(false)
    }
  }

  // OTP 재발송
  const handleResendOtp = async () => {
    try {
      const response = await authApi.resendOtp(email)
      setCountdown(300)
      setOtpCode('')
      toast.success(`인증 코드가 ${response.data.email_hint || '이메일'}로 재전송되었습니다`)
    } catch {
      toast.error('인증 코드 재전송에 실패했습니다')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-600 to-indigo-800">
      <div className="max-w-md w-full mx-4">
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-blue-600 to-indigo-600 p-6 text-white text-center">
            <h1 className="text-2xl font-bold">Smart Finance Core</h1>
            <p className="text-blue-100 text-sm mt-1">AI 기반 회계/재무 관리 플랫폼</p>
          </div>

          <div className="p-6">
            {step === 'email' ? (
              /* Step 1: 이메일 입력 */
              <form onSubmit={handleEmailSubmit} className="space-y-5">
                <div className="text-center mb-2">
                  <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-blue-100 mb-3">
                    <EnvelopeIcon className="w-7 h-7 text-blue-600" />
                  </div>
                  <h2 className="text-lg font-semibold text-gray-900">이메일로 로그인</h2>
                  <p className="text-sm text-gray-500 mt-1">
                    이메일 주소를 입력하면 인증 코드를 보내드립니다
                  </p>
                </div>

                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                    이메일 주소
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base"
                    placeholder="name@company.com"
                    autoFocus
                    autoComplete="email"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading || !email.trim()}
                  className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3 rounded-lg font-medium hover:from-blue-700 hover:to-indigo-700 transition-all disabled:opacity-50"
                >
                  {isLoading ? '전송 중...' : '인증 코드 받기'}
                </button>
              </form>
            ) : (
              /* Step 2: OTP 입력 */
              <div className="space-y-5">
                <div className="text-center mb-2">
                  <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-green-100 mb-3">
                    <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h2 className="text-lg font-semibold text-gray-900">인증 코드 입력</h2>
                  <p className="text-sm text-gray-500 mt-1">
                    <span className="font-medium text-gray-700">{emailHint}</span>으로<br />
                    전송된 6자리 인증 코드를 입력하세요
                  </p>
                </div>

                <div>
                  <input
                    type="text"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="w-full px-4 py-4 text-center text-3xl font-mono tracking-[0.5em] border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="000000"
                    maxLength={6}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && otpCode.length === 6) handleOtpSubmit()
                    }}
                  />
                </div>

                {countdown > 0 && (
                  <p className="text-center text-sm text-gray-500">
                    유효 시간:{' '}
                    <span className="font-medium text-blue-600">
                      {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
                    </span>
                  </p>
                )}

                <button
                  type="button"
                  onClick={handleOtpSubmit}
                  disabled={isLoading || otpCode.length !== 6}
                  className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3 rounded-lg font-medium hover:from-blue-700 hover:to-indigo-700 transition-all disabled:opacity-50"
                >
                  {isLoading ? '인증 중...' : '로그인'}
                </button>

                <div className="flex items-center justify-between text-sm">
                  <button
                    type="button"
                    onClick={handleResendOtp}
                    className="text-blue-600 hover:text-blue-800 font-medium"
                  >
                    인증 코드 재전송
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setStep('email')
                      setOtpCode('')
                      setCountdown(0)
                    }}
                    className="text-gray-500 hover:text-gray-700"
                  >
                    다른 이메일 사용
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <p className="text-center text-white text-sm mt-6 opacity-80">
          &copy; 2024 Smart Finance Core. All rights reserved.
        </p>
      </div>
    </div>
  )
}
