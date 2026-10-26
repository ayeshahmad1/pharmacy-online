import type {
  CreateUserBody,
  ListUsersQuery,
  Paginated,
  ResetPasswordBody,
  UpdateUserBody,
  UserDto,
} from '@pharmacy/shared';
import { api } from '@/lib/api';

export const usersKeys = {
  all: ['users'] as const,
  list: (query: Partial<ListUsersQuery>) => ['users', 'list', query] as const,
};

type UserResponse = { user: UserDto };

/** User management; every endpoint is ADMIN only. */
export const usersApi = {
  list: (query: Partial<ListUsersQuery>, signal?: AbortSignal) =>
    api.get<Paginated<UserDto>>('/users', query, signal),
  create: async (body: CreateUserBody) => (await api.post<UserResponse>('/users', body)).user,
  update: async (id: string, body: UpdateUserBody) =>
    (await api.patch<UserResponse>(`/users/${id}`, body)).user,
  setActive: async (id: string, active: boolean) =>
    (await api.post<UserResponse>(`/users/${id}/${active ? 'activate' : 'deactivate'}`)).user,
  /** Also signs the user out everywhere. */
  resetPassword: (id: string, body: ResetPasswordBody) =>
    api.post<void>(`/users/${id}/reset-password`, body),
};
