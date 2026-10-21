// 紧急联系人接口（docs/API.md §3；backend/src/contacts 已实现并核对，上限 5 个）
import type {
  CreateEmergencyContactRequest,
  EmergencyContact,
  UpdateEmergencyContactRequest,
} from "@helmet/shared";
import { api, apiList } from "./client";

export const contactsApi = {
  list: () => apiList<EmergencyContact>("/users/me/emergency-contacts"),

  create: (body: CreateEmergencyContactRequest) =>
    api<EmergencyContact>("/users/me/emergency-contacts", {
      method: "POST",
      body,
    }),

  update: (contactId: string, body: UpdateEmergencyContactRequest) =>
    api<EmergencyContact>(
      `/users/me/emergency-contacts/${encodeURIComponent(contactId)}`,
      { method: "PATCH", body },
    ),

  remove: (contactId: string) =>
    api<void>(`/users/me/emergency-contacts/${encodeURIComponent(contactId)}`, {
      method: "DELETE",
    }),
};
