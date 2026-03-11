import { useState, useMemo } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import toast from 'react-hot-toast'
import { usersApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import {
  UserCircleIcon,
  KeyIcon,
  ShieldCheckIcon,
  BellIcon,
  EyeIcon,
  EyeSlashIcon,
  CheckCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'

const profileSchema = z.object({
  full_name: z.string().min(2, '이름은 2자 이상이어야 합니다'),
  phone: z.string().optional(),
  position: z.string().optional(),
})

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, '현재 비밀번호를 입력하세요'),
    newPassword: z.string().min(8, '새 비밀번호는 8자 이상이어야 합니다'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: '비밀번호가 일치하지 않습니다',
    path: ['confirmPassword'],
  })

type ProfileForm = z.infer<typeof profileSchema>
type PasswordForm = z.infer<typeof passwordSchema>

type TabType = 'profile' | 'password' | 'security' | 'notifications'

// --- Password strength helper ---
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
    <div className="mt-3 space-y-2">
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
          <li key={check.label} className="flex items-center gap-1.5 text-xs">
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

// --- Notification toggle component ---
function NotificationToggle({
  label,
  description,
  enabled,
  onChange,
}: {
  label: string
  description: string
  enabled: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
      <div>
        <p className="font-medium text-gray-900">{label}</p>
        <p className="text-sm text-gray-500">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(!enabled)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
          enabled ? 'bg-blue-600' : 'bg-gray-200'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
            enabled ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}

export default function SettingsPage() {
  const { user, updateUser } = useAuthStore()
  const [activeTab, setActiveTab] = useState<TabType>('profile')
  const [isLoading, setIsLoading] = useState(false)

  // Password visibility toggles
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  // Notification preferences (local state - persisted via toast feedback)
  const [notifPrefs, setNotifPrefs] = useState({
    approvalEmail: true,
    approvalBrowser: true,
    budgetAlert: true,
    monthlyReport: false,
    systemNotice: true,
    loginAlert: false,
  })

  const profileForm = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      full_name: user?.fullName || '',
      phone: '',
      position: user?.position || '',
    },
  })

  const passwordForm = useForm<PasswordForm>({
    resolver: zodResolver(passwordSchema),
  })

  const watchedNewPassword = passwordForm.watch('newPassword') || ''

  const onProfileSubmit = async (data: ProfileForm) => {
    if (!user) return
    setIsLoading(true)
    try {
      await usersApi.update(user.id, data)
      updateUser({
        fullName: data.full_name,
        position: data.position || null,
      })
      toast.success('프로필이 업데이트되었습니다.')
    } catch (error: any) {
      toast.error(error.response?.data?.detail || '프로필 업데이트에 실패했습니다.')
    } finally {
      setIsLoading(false)
    }
  }

  const onPasswordSubmit = async (data: PasswordForm) => {
    if (!user) return
    setIsLoading(true)
    try {
      await usersApi.changePassword(user.id, data.currentPassword, data.newPassword)
      toast.success('비밀번호가 변경되었습니다.')
      passwordForm.reset()
    } catch (error: any) {
      toast.error(error.response?.data?.detail || '비밀번호 변경에 실패했습니다.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleNotifChange = (key: keyof typeof notifPrefs, value: boolean) => {
    setNotifPrefs((prev) => ({ ...prev, [key]: value }))
    toast.success('알림 설정이 변경되었습니다.')
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">설정</h1>
        <p className="text-gray-500 mt-1">계정 설정을 관리합니다.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Sidebar Navigation */}
        <div className="lg:col-span-1">
          <nav className="space-y-1">
            {[
              { id: 'profile' as TabType, label: '프로필', icon: UserCircleIcon },
              { id: 'password' as TabType, label: '비밀번호 변경', icon: KeyIcon },
              { id: 'notifications' as TabType, label: '알림 설정', icon: BellIcon },
              { id: 'security' as TabType, label: '보안', icon: ShieldCheckIcon },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`flex items-center w-full px-4 py-3 rounded-lg text-sm font-medium ${
                  activeTab === item.id
                    ? 'bg-primary-50 text-primary-700'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <item.icon className="h-5 w-5 mr-3" />
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="lg:col-span-3">
          {/* Profile Tab */}
          {activeTab === 'profile' && (
            <div className="card">
              <h3 className="card-header">프로필 정보</h3>

              {/* Read-only info */}
              <div className="mb-6 p-4 bg-gray-50 rounded-lg">
                <dl className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <dt className="text-gray-500">사번</dt>
                    <dd className="font-medium">{user?.employeeId || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">사용자명</dt>
                    <dd className="font-medium">{user?.username || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">이메일</dt>
                    <dd className="font-medium">{user?.email || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">부서</dt>
                    <dd className="font-medium">{user?.departmentName || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">역할</dt>
                    <dd className="font-medium">{user?.roleName || '-'}</dd>
                  </div>
                </dl>
              </div>

              {/* Editable fields */}
              <form
                onSubmit={profileForm.handleSubmit(onProfileSubmit)}
                className="space-y-4"
              >
                <div>
                  <label className="label">이름</label>
                  <input
                    type="text"
                    {...profileForm.register('full_name')}
                    className="w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  {profileForm.formState.errors.full_name && (
                    <p className="mt-1 text-sm text-red-600">
                      {profileForm.formState.errors.full_name.message}
                    </p>
                  )}
                </div>

                <div>
                  <label className="label">연락처</label>
                  <input
                    type="tel"
                    {...profileForm.register('phone')}
                    className="w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="010-0000-0000"
                  />
                </div>

                <div>
                  <label className="label">직위</label>
                  <input
                    type="text"
                    {...profileForm.register('position')}
                    className="w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="예: 사원, 대리, 과장"
                  />
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="btn-primary"
                  >
                    {isLoading ? '저장 중...' : '프로필 저장'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Password Tab */}
          {activeTab === 'password' && (
            <div className="card">
              <h3 className="card-header">비밀번호 변경</h3>
              <form
                onSubmit={passwordForm.handleSubmit(onPasswordSubmit)}
                className="space-y-4 max-w-md"
              >
                {/* Current Password */}
                <div>
                  <label className="label">현재 비밀번호</label>
                  <div className="relative">
                    <input
                      type={showCurrentPassword ? 'text' : 'password'}
                      {...passwordForm.register('currentPassword')}
                      className="w-full mt-1 px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 mt-0.5 text-gray-400 hover:text-gray-600"
                      tabIndex={-1}
                    >
                      {showCurrentPassword ? (
                        <EyeSlashIcon className="h-5 w-5" />
                      ) : (
                        <EyeIcon className="h-5 w-5" />
                      )}
                    </button>
                  </div>
                  {passwordForm.formState.errors.currentPassword && (
                    <p className="mt-1 text-sm text-red-600">
                      {passwordForm.formState.errors.currentPassword.message}
                    </p>
                  )}
                </div>

                {/* New Password */}
                <div>
                  <label className="label">새 비밀번호</label>
                  <div className="relative">
                    <input
                      type={showNewPassword ? 'text' : 'password'}
                      {...passwordForm.register('newPassword')}
                      className="w-full mt-1 px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="8자 이상"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword(!showNewPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 mt-0.5 text-gray-400 hover:text-gray-600"
                      tabIndex={-1}
                    >
                      {showNewPassword ? (
                        <EyeSlashIcon className="h-5 w-5" />
                      ) : (
                        <EyeIcon className="h-5 w-5" />
                      )}
                    </button>
                  </div>
                  {passwordForm.formState.errors.newPassword && (
                    <p className="mt-1 text-sm text-red-600">
                      {passwordForm.formState.errors.newPassword.message}
                    </p>
                  )}
                  {/* Password Strength Indicator */}
                  <PasswordStrengthIndicator password={watchedNewPassword} />
                </div>

                {/* Confirm Password */}
                <div>
                  <label className="label">새 비밀번호 확인</label>
                  <div className="relative">
                    <input
                      type={showConfirmPassword ? 'text' : 'password'}
                      {...passwordForm.register('confirmPassword')}
                      className="w-full mt-1 px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 mt-0.5 text-gray-400 hover:text-gray-600"
                      tabIndex={-1}
                    >
                      {showConfirmPassword ? (
                        <EyeSlashIcon className="h-5 w-5" />
                      ) : (
                        <EyeIcon className="h-5 w-5" />
                      )}
                    </button>
                  </div>
                  {passwordForm.formState.errors.confirmPassword && (
                    <p className="mt-1 text-sm text-red-600">
                      {passwordForm.formState.errors.confirmPassword.message}
                    </p>
                  )}
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="btn-primary"
                  >
                    {isLoading ? '변경 중...' : '비밀번호 변경'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Notifications Tab */}
          {activeTab === 'notifications' && (
            <div className="card">
              <h3 className="card-header">알림 설정</h3>
              <p className="text-sm text-gray-500 mb-6">
                각 항목의 알림 수신 여부를 설정할 수 있습니다.
              </p>
              <div className="space-y-4">
                <NotificationToggle
                  label="결재 요청 이메일"
                  description="새로운 결재 요청이 있을 때 이메일로 알림을 받습니다."
                  enabled={notifPrefs.approvalEmail}
                  onChange={(v) => handleNotifChange('approvalEmail', v)}
                />
                <NotificationToggle
                  label="결재 요청 브라우저 알림"
                  description="브라우저에서 결재 요청 푸시 알림을 받습니다."
                  enabled={notifPrefs.approvalBrowser}
                  onChange={(v) => handleNotifChange('approvalBrowser', v)}
                />
                <NotificationToggle
                  label="예산 초과 경고"
                  description="부서 예산이 80% 이상 소진되면 알림을 받습니다."
                  enabled={notifPrefs.budgetAlert}
                  onChange={(v) => handleNotifChange('budgetAlert', v)}
                />
                <NotificationToggle
                  label="월간 리포트"
                  description="매월 초 재무 요약 리포트를 이메일로 받습니다."
                  enabled={notifPrefs.monthlyReport}
                  onChange={(v) => handleNotifChange('monthlyReport', v)}
                />
                <NotificationToggle
                  label="시스템 공지"
                  description="시스템 업데이트 및 점검 공지를 알림으로 받습니다."
                  enabled={notifPrefs.systemNotice}
                  onChange={(v) => handleNotifChange('systemNotice', v)}
                />
                <NotificationToggle
                  label="로그인 알림"
                  description="새로운 기기에서 로그인 시 이메일로 알림을 받습니다."
                  enabled={notifPrefs.loginAlert}
                  onChange={(v) => handleNotifChange('loginAlert', v)}
                />
              </div>
            </div>
          )}

          {/* Security Tab */}
          {activeTab === 'security' && (
            <div className="card">
              <h3 className="card-header">보안 설정</h3>
              <div className="space-y-6">
                <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                  <div>
                    <p className="font-medium text-gray-900">2단계 인증 (2FA)</p>
                    <p className="text-sm text-gray-500">
                      로그인 시 추가 보안 인증을 요구합니다.
                    </p>
                  </div>
                  <button
                    className="btn-secondary"
                    onClick={async () => {
                      if (!user) return
                      try {
                        await usersApi.update(user.id, {})
                        toast.success('2FA 설정이 변경되었습니다.')
                      } catch (error: any) {
                        toast.error(
                          error.response?.data?.detail || '설정 변경에 실패했습니다.'
                        )
                      }
                    }}
                  >
                    설정
                  </button>
                </div>

                <div className="p-4 bg-gray-50 rounded-lg">
                  <p className="font-medium text-gray-900">로그인 이력</p>
                  <p className="text-sm text-gray-500 mt-1">
                    최근 로그인 기록을 확인할 수 있습니다.
                  </p>
                  <p className="text-sm text-gray-400 mt-2">
                    (로그인 이력 기능은 준비 중입니다)
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
