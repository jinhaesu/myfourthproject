import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import toast from 'react-hot-toast'
import { useAuthStore } from '@/store/authStore'
import { authApi } from '@/services/api'
import {
  EyeIcon,
  EyeSlashIcon,
  CheckCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'

const loginSchema = z.object({
  username: z.string().min(1, '사용자명을 입력하세요'),
  password: z.string().min(1, '비밀번호를 입력하세요'),
  otpCode: z.string().optional(),
})

const registerSchema = z.object({
  email: z.string().email('올바른 이메일 형식이 아닙니다'),
  username: z.string().min(3, '사용자명은 3자 이상이어야 합니다'),
  password: z.string().min(8, '비밀번호는 8자 이상이어야 합니다'),
  passwordConfirm: z.string(),
  full_name: z.string().min(2, '이름을 입력하세요'),
  phone: z.string().optional(),
  department_code: z.string().optional(),
  position: z.string().optional(),
}).refine((data) => data.password === data.passwordConfirm, {
  message: '비밀번호가 일치하지 않습니다',
  path: ['passwordConfirm'],
})

type LoginForm = z.infer<typeof loginSchema>
type RegisterForm = z.infer<typeof registerSchema>

// --- Password strength helpers ---
interface PasswordCheck {
  label: string
  met: boolean
}

function getPasswordChecks(password: string): PasswordCheck[] {
  return [
    { label: '8자 이상', met: password.length >= 8 },
    { label: '대문자 포함', met: /[A-Z]/.test(password) },
    { label: '소문자 포함', met: /[a-z]/.test(password) },
    { label: '숫자 포함', met: /[0-9]/.test(password) },
    { label: '특수문자 포함', met: /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password) },
  ]
}

function getStrengthLevel(checks: PasswordCheck[]): { level: number; label: string; color: string } {
  const metCount = checks.filter((c) => c.met).length
  if (metCount <= 1) return { level: 1, label: '매우 약함', color: 'bg-red-500' }
  if (metCount === 2) return { level: 2, label: '약함', color: 'bg-orange-500' }
  if (metCount === 3) return { level: 3, label: '보통', color: 'bg-yellow-500' }
  if (metCount === 4) return { level: 4, label: '강함', color: 'bg-blue-500' }
  return { level: 5, label: '매우 강함', color: 'bg-green-500' }
}

function PasswordStrengthIndicator({ password }: { password: string }) {
  const checks = useMemo(() => getPasswordChecks(password), [password])
  const strength = useMemo(() => getStrengthLevel(checks), [checks])

  if (!password) return null

  return (
    <div className="mt-2 space-y-2">
      {/* Strength bar */}
      <div className="flex items-center gap-2">
        <div className="flex-1 flex gap-1">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                i <= strength.level ? strength.color : 'bg-gray-200'
              }`}
            />
          ))}
        </div>
        <span className={`text-xs font-medium ${
          strength.level <= 2 ? 'text-red-600' :
          strength.level === 3 ? 'text-yellow-600' :
          'text-green-600'
        }`}>
          {strength.label}
        </span>
      </div>

      {/* Checklist */}
      <ul className="grid grid-cols-2 gap-1">
        {checks.map((check) => (
          <li key={check.label} className="flex items-center gap-1 text-xs">
            {check.met ? (
              <CheckCircleIcon className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
            ) : (
              <XCircleIcon className="h-3.5 w-3.5 text-gray-300 flex-shrink-0" />
            )}
            <span className={check.met ? 'text-green-700' : 'text-gray-400'}>{check.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function LoginPage() {
  const navigate = useNavigate()
  const login = useAuthStore((state) => state.login)
  const [requires2FA, setRequires2FA] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isRegisterMode, setIsRegisterMode] = useState(false)

  // Show/hide password toggles
  const [showLoginPassword, setShowLoginPassword] = useState(false)
  const [showRegisterPassword, setShowRegisterPassword] = useState(false)
  const [showRegisterConfirm, setShowRegisterConfirm] = useState(false)

  const loginForm = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  })

  const registerForm = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
  })

  const watchedRegisterPassword = registerForm.watch('password') || ''

  const onLoginSubmit = async (data: LoginForm) => {
    setIsLoading(true)
    try {
      const response = await authApi.login(data.username, data.password, data.otpCode)
      const result = response.data

      if (result.requires_2fa && !data.otpCode) {
        setRequires2FA(true)
        toast.success('2차 인증 코드를 입력하세요')
        setIsLoading(false)
        return
      }

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
      const message = error.response?.data?.detail || '로그인에 실패했습니다'
      toast.error(message)
    } finally {
      setIsLoading(false)
    }
  }

  const onRegisterSubmit = async (data: RegisterForm) => {
    setIsLoading(true)
    try {
      await authApi.register({
        email: data.email,
        username: data.username,
        password: data.password,
        full_name: data.full_name,
        phone: data.phone,
        department_code: data.department_code,
        position: data.position,
      })

      toast.success('회원가입 신청이 완료되었습니다. 관리자 승인 후 로그인이 가능합니다.')
      registerForm.reset()
      setIsRegisterMode(false)
    } catch (error: any) {
      const message = error.response?.data?.detail || '회원가입에 실패했습니다'
      toast.error(message)
    } finally {
      setIsLoading(false)
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

          {/* Tabs */}
          <div className="flex border-b">
            <button
              type="button"
              className={`flex-1 py-3 text-center font-medium transition-colors ${
                !isRegisterMode
                  ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setIsRegisterMode(false)}
            >
              로그인
            </button>
            <button
              type="button"
              className={`flex-1 py-3 text-center font-medium transition-colors ${
                isRegisterMode
                  ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setIsRegisterMode(true)}
            >
              회원가입
            </button>
          </div>

          <div className="p-6">
            {!isRegisterMode ? (
              /* Login Form */
              <form onSubmit={loginForm.handleSubmit(onLoginSubmit)} className="space-y-4">
                <div>
                  <label htmlFor="login-username" className="block text-sm font-medium text-gray-700 mb-1">
                    이메일 또는 사용자명
                  </label>
                  <input
                    id="login-username"
                    type="text"
                    {...loginForm.register('username')}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="이메일 또는 사용자명"
                  />
                  {loginForm.formState.errors.username && (
                    <p className="mt-1 text-sm text-red-600">{loginForm.formState.errors.username.message}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="login-password" className="block text-sm font-medium text-gray-700 mb-1">
                    비밀번호
                  </label>
                  <div className="relative">
                    <input
                      id="login-password"
                      type={showLoginPassword ? 'text' : 'password'}
                      {...loginForm.register('password')}
                      className="w-full px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="비밀번호"
                    />
                    <button
                      type="button"
                      onClick={() => setShowLoginPassword(!showLoginPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      tabIndex={-1}
                    >
                      {showLoginPassword ? (
                        <EyeSlashIcon className="h-5 w-5" />
                      ) : (
                        <EyeIcon className="h-5 w-5" />
                      )}
                    </button>
                  </div>
                  {loginForm.formState.errors.password && (
                    <p className="mt-1 text-sm text-red-600">{loginForm.formState.errors.password.message}</p>
                  )}
                </div>

                {requires2FA && (
                  <div>
                    <label htmlFor="login-otp" className="block text-sm font-medium text-gray-700 mb-1">
                      2차 인증 코드
                    </label>
                    <input
                      id="login-otp"
                      type="text"
                      {...loginForm.register('otpCode')}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="6자리 코드"
                      maxLength={6}
                    />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3 rounded-lg font-medium hover:from-blue-700 hover:to-indigo-700 transition-all disabled:opacity-50"
                >
                  {isLoading ? '로그인 중...' : '로그인'}
                </button>
              </form>
            ) : (
              /* Register Form */
              <form onSubmit={registerForm.handleSubmit(onRegisterSubmit)} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      이메일 <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="email"
                      {...registerForm.register('email')}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="이메일 주소"
                    />
                    {registerForm.formState.errors.email && (
                      <p className="mt-1 text-sm text-red-600">{registerForm.formState.errors.email.message}</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      사용자명 <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      {...registerForm.register('username')}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="사용자명"
                    />
                    {registerForm.formState.errors.username && (
                      <p className="mt-1 text-sm text-red-600">{registerForm.formState.errors.username.message}</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      이름 <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      {...registerForm.register('full_name')}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="실명"
                    />
                    {registerForm.formState.errors.full_name && (
                      <p className="mt-1 text-sm text-red-600">{registerForm.formState.errors.full_name.message}</p>
                    )}
                  </div>

                  {/* Password with strength indicator */}
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      비밀번호 <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <input
                        type={showRegisterPassword ? 'text' : 'password'}
                        {...registerForm.register('password')}
                        className="w-full px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="8자 이상"
                      />
                      <button
                        type="button"
                        onClick={() => setShowRegisterPassword(!showRegisterPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        tabIndex={-1}
                      >
                        {showRegisterPassword ? (
                          <EyeSlashIcon className="h-5 w-5" />
                        ) : (
                          <EyeIcon className="h-5 w-5" />
                        )}
                      </button>
                    </div>
                    {registerForm.formState.errors.password && (
                      <p className="mt-1 text-sm text-red-600">{registerForm.formState.errors.password.message}</p>
                    )}
                    {/* Password Strength Indicator */}
                    <PasswordStrengthIndicator password={watchedRegisterPassword} />
                  </div>

                  {/* Confirm password */}
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      비밀번호 확인 <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <input
                        type={showRegisterConfirm ? 'text' : 'password'}
                        {...registerForm.register('passwordConfirm')}
                        className="w-full px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="비밀번호 재입력"
                      />
                      <button
                        type="button"
                        onClick={() => setShowRegisterConfirm(!showRegisterConfirm)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        tabIndex={-1}
                      >
                        {showRegisterConfirm ? (
                          <EyeSlashIcon className="h-5 w-5" />
                        ) : (
                          <EyeIcon className="h-5 w-5" />
                        )}
                      </button>
                    </div>
                    {registerForm.formState.errors.passwordConfirm && (
                      <p className="mt-1 text-sm text-red-600">{registerForm.formState.errors.passwordConfirm.message}</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      연락처
                    </label>
                    <input
                      type="tel"
                      {...registerForm.register('phone')}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="010-0000-0000"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      부서
                    </label>
                    <select
                      {...registerForm.register('department_code')}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      <option value="">선택</option>
                      <option value="FIN">재무팀</option>
                      <option value="HR">인사팀</option>
                      <option value="DEV">개발팀</option>
                      <option value="SALES">영업팀</option>
                      <option value="MKT">마케팅팀</option>
                    </select>
                  </div>

                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      직위
                    </label>
                    <input
                      type="text"
                      {...registerForm.register('position')}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="예: 사원, 대리, 과장"
                    />
                  </div>
                </div>

                <p className="text-xs text-gray-500">
                  <span className="text-red-500">*</span> 표시는 필수 항목입니다.
                  회원가입 후 관리자 승인이 필요합니다.
                </p>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-gradient-to-r from-green-600 to-emerald-600 text-white py-3 rounded-lg font-medium hover:from-green-700 hover:to-emerald-700 transition-all disabled:opacity-50"
                >
                  {isLoading ? '가입 신청 중...' : '회원가입 신청'}
                </button>
              </form>
            )}
          </div>

          {/* Test Account Info */}
          <div className="bg-gray-50 p-4 text-center text-sm text-gray-600 border-t">
            <p className="font-medium text-gray-700 mb-1">테스트 계정</p>
            <p>admin@smartfinance.com / admin123!</p>
          </div>
        </div>

        <p className="text-center text-white text-sm mt-6 opacity-80">
          &copy; 2024 Smart Finance Core. All rights reserved.
        </p>
      </div>
    </div>
  )
}
