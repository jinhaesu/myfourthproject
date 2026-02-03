import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import toast from 'react-hot-toast'
import { useAuthStore } from '@/store/authStore'
import { authApi } from '@/services/api'

const loginSchema = z.object({
  username: z.string().min(1, '사용자명을 입력하세요'),
  password: z.string().min(1, '비밀번호를 입력하세요'),
  otpCode: z.string().optional(),
})

type LoginForm = z.infer<typeof loginSchema>

export default function LoginPage() {
  const navigate = useNavigate()
  const login = useAuthStore((state) => state.login)
  const [requires2FA, setRequires2FA] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  })

  const onSubmit = async (data: LoginForm) => {
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-500 to-primary-700">
      <div className="max-w-md w-full mx-4">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Smart Finance Core</h1>
            <p className="text-gray-500 mt-2">AI 기반 회계 자동화 플랫폼</p>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
            <div>
              <label htmlFor="username" className="label">
                사용자명 또는 이메일
              </label>
              <input
                id="username"
                type="text"
                {...register('username')}
                className="input mt-1"
                placeholder="사번 또는 이메일"
              />
              {errors.username && (
                <p className="mt-1 text-sm text-red-600">{errors.username.message}</p>
              )}
            </div>

            <div>
              <label htmlFor="password" className="label">
                비밀번호
              </label>
              <input
                id="password"
                type="password"
                {...register('password')}
                className="input mt-1"
                placeholder="비밀번호"
              />
              {errors.password && (
                <p className="mt-1 text-sm text-red-600">{errors.password.message}</p>
              )}
            </div>

            {requires2FA && (
              <div>
                <label htmlFor="otpCode" className="label">
                  2차 인증 코드
                </label>
                <input
                  id="otpCode"
                  type="text"
                  {...register('otpCode')}
                  className="input mt-1"
                  placeholder="6자리 코드"
                  maxLength={6}
                />
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full btn-primary py-3 text-base"
            >
              {isLoading ? '로그인 중...' : '로그인'}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-gray-500">
            <p>비밀번호를 잊으셨나요?</p>
            <a href="#" className="text-primary-600 hover:text-primary-500">
              관리자에게 문의하세요
            </a>
          </div>
        </div>

        <p className="text-center text-white text-sm mt-8">
          &copy; 2024 Smart Finance Core. All rights reserved.
        </p>
      </div>
    </div>
  )
}
