import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface User {
  id: number
  employeeId: string
  email: string
  username: string
  fullName: string
  departmentId: number | null
  departmentName: string | null
  roleId: number | null
  roleName: string | null
  position: string | null
  isAdmin: boolean
}

export type MenuMode = 'employee' | 'admin'

interface AuthState {
  isAuthenticated: boolean
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  menuMode: MenuMode

  login: (user: User, accessToken: string, refreshToken: string) => void
  logout: () => void
  updateUser: (user: Partial<User>) => void
  setMenuMode: (mode: MenuMode) => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      user: null,
      accessToken: null,
      refreshToken: null,
      menuMode: 'employee',

      login: (user, accessToken, refreshToken) =>
        set({
          isAuthenticated: true,
          user,
          accessToken,
          refreshToken,
          // 관리자는 관리자 메뉴로 시작, 직원은 직원용 고정
          menuMode: user.isAdmin ? 'admin' : 'employee',
        }),

      logout: () =>
        set({
          isAuthenticated: false,
          user: null,
          accessToken: null,
          refreshToken: null,
          menuMode: 'employee',
        }),

      updateUser: (userData) =>
        set((state) => ({
          user: state.user ? { ...state.user, ...userData } : null,
        })),

      setMenuMode: (mode) => set({ menuMode: mode }),
    }),
    {
      name: 'auth-storage',
    }
  )
)
