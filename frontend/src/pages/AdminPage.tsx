import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { usersApi } from '@/services/api'

interface User {
  id: number
  employee_id: string
  email: string
  username: string
  full_name: string
  phone?: string
  department_name?: string
  role_name?: string
  position?: string
  is_active: boolean
  created_at: string
}

interface Role {
  id: number
  name: string
  description: string
}

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<'pending' | 'all'>('pending')
  const [pendingUsers, setPendingUsers] = useState<User[]>([])
  const [allUsers, setAllUsers] = useState<User[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [loading, setLoading] = useState(false)
  const [approveModalOpen, setApproveModalOpen] = useState(false)
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [employeeId, setEmployeeId] = useState('')

  useEffect(() => {
    loadData()
  }, [activeTab])

  const loadData = async () => {
    setLoading(true)
    try {
      if (activeTab === 'pending') {
        const response = await usersApi.getPendingUsers()
        setPendingUsers(response.data)
      } else {
        const [usersRes, rolesRes] = await Promise.all([
          usersApi.getAllUsers(),
          usersApi.getRoles()
        ])
        setAllUsers(usersRes.data)
        setRoles(rolesRes.data)
      }
    } catch (error: any) {
      toast.error('데이터를 불러오는데 실패했습니다.')
    } finally {
      setLoading(false)
    }
  }

  const handleApproveClick = (user: User) => {
    setSelectedUser(user)
    setEmployeeId('')
    setApproveModalOpen(true)
  }

  const handleApprove = async () => {
    if (!selectedUser || !employeeId.trim()) {
      toast.error('사번을 입력해주세요.')
      return
    }

    try {
      await usersApi.approveUser(selectedUser.id, employeeId)
      toast.success(`${selectedUser.full_name}님이 승인되었습니다.`)
      setApproveModalOpen(false)
      loadData()
    } catch (error: any) {
      toast.error(error.response?.data?.detail || '승인에 실패했습니다.')
    }
  }

  const handleReject = async (user: User) => {
    if (!confirm(`${user.full_name}님의 가입을 거절하시겠습니까?`)) return

    try {
      await usersApi.rejectUser(user.id)
      toast.success('가입이 거절되었습니다.')
      loadData()
    } catch (error: any) {
      toast.error(error.response?.data?.detail || '거절에 실패했습니다.')
    }
  }

  const handleToggleActive = async (user: User) => {
    try {
      if (user.is_active) {
        await usersApi.deactivateUser(user.id)
        toast.success(`${user.full_name}님이 비활성화되었습니다.`)
      } else {
        await usersApi.activateUser(user.id)
        toast.success(`${user.full_name}님이 활성화되었습니다.`)
      }
      loadData()
    } catch (error: any) {
      toast.error(error.response?.data?.detail || '상태 변경에 실패했습니다.')
    }
  }

  const handleRoleChange = async (userId: number, roleId: number) => {
    try {
      await usersApi.updateUserRole(userId, roleId)
      toast.success('역할이 변경되었습니다.')
      loadData()
    } catch (error: any) {
      toast.error(error.response?.data?.detail || '역할 변경에 실패했습니다.')
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">관리자</h1>
        <p className="text-gray-500 mt-1">사용자 및 시스템 관리</p>
      </div>

      {/* Tabs */}
      <div className="flex space-x-1 bg-gray-100 p-1 rounded-lg w-fit mb-6">
        <button
          onClick={() => setActiveTab('pending')}
          className={`px-4 py-2 rounded-md font-medium transition-colors ${
            activeTab === 'pending'
              ? 'bg-white text-blue-600 shadow'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          가입 승인 대기
          {pendingUsers.length > 0 && (
            <span className="ml-2 bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">
              {pendingUsers.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('all')}
          className={`px-4 py-2 rounded-md font-medium transition-colors ${
            activeTab === 'all'
              ? 'bg-white text-blue-600 shadow'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          전체 사용자
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : activeTab === 'pending' ? (
        /* Pending Users */
        <div className="bg-white rounded-xl shadow-sm border border-gray-200">
          {pendingUsers.length === 0 ? (
            <div className="p-12 text-center text-gray-500">
              <svg className="w-16 h-16 mx-auto text-gray-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-lg font-medium">승인 대기 중인 사용자가 없습니다</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">이름</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">이메일</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">부서</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">직위</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">신청일</th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">액션</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {pendingUsers.map((user) => (
                    <tr key={user.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="font-medium text-gray-900">{user.full_name}</div>
                        <div className="text-sm text-gray-500">@{user.username}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {user.email}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {user.department_name || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {user.position || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {new Date(user.created_at).toLocaleDateString('ko-KR')}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <button
                          onClick={() => handleApproveClick(user)}
                          className="bg-green-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-green-700 mr-2"
                        >
                          승인
                        </button>
                        <button
                          onClick={() => handleReject(user)}
                          className="bg-red-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-red-700"
                        >
                          거절
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        /* All Users */
        <div className="bg-white rounded-xl shadow-sm border border-gray-200">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">사번</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">이름</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">이메일</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">부서</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">역할</th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">상태</th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">액션</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {allUsers.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {user.employee_id}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="font-medium text-gray-900">{user.full_name}</div>
                      <div className="text-sm text-gray-500">@{user.username}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {user.email}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {user.department_name || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <select
                        value={roles.find(r => r.name === user.role_name)?.id || ''}
                        onChange={(e) => handleRoleChange(user.id, parseInt(e.target.value))}
                        className="text-sm border border-gray-300 rounded-lg px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        {roles.map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                        user.is_active
                          ? 'bg-green-100 text-green-800'
                          : 'bg-red-100 text-red-800'
                      }`}>
                        {user.is_active ? '활성' : '비활성'}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <button
                        onClick={() => handleToggleActive(user)}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                          user.is_active
                            ? 'bg-red-100 text-red-700 hover:bg-red-200'
                            : 'bg-green-100 text-green-700 hover:bg-green-200'
                        }`}
                      >
                        {user.is_active ? '비활성화' : '활성화'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Approve Modal */}
      {approveModalOpen && selectedUser && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="text-lg font-bold text-gray-900 mb-4">사용자 승인</h3>
            <p className="text-gray-600 mb-4">
              <span className="font-medium">{selectedUser.full_name}</span>님의 가입을 승인하려면 사번을 입력하세요.
            </p>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                사번 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="예: EMP001"
              />
            </div>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setApproveModalOpen(false)}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
              >
                취소
              </button>
              <button
                onClick={handleApprove}
                className="px-4 py-2 text-white bg-green-600 rounded-lg hover:bg-green-700"
              >
                승인
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
