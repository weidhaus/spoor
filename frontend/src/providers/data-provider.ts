import type { BaseRecord, DataProvider } from "@refinedev/core";

import { api } from "@/lib/api";

type ListResponse = { data: BaseRecord[]; total: number } & Record<string, unknown>;

// Maps Refine's resource calls onto /api/<resource>. Lists are paged on the server and return their total;
// filters are passed as plain query parameters that the API whitelists.
export const dataProvider: DataProvider = {
  getApiUrl: () => "/api",

  getList: async ({ resource, pagination, sorters, filters }) => {
    const query: Record<string, string> = {
      page: String(pagination?.currentPage ?? 1),
      page_size: String(pagination?.pageSize ?? 25),
    };
    const sorter = sorters?.[0];
    if (sorter) {
      query.sort = sorter.field;
      query.order = sorter.order;
    }
    for (const f of filters ?? []) {
      if ("field" in f && f.value !== undefined && f.value !== null && f.value !== "") query[f.field] = String(f.value);
    }
    const res = await api<ListResponse>(`/api/${resource}`, { query });
    const { data, total, ...extra } = res;
    return { data: data as never, total, extra };
  },

  getOne: async ({ resource, id }) => ({ data: await api(`/api/${resource}/${id}`) as never }),

  create: async ({ resource, variables }) => ({
    data: await api(`/api/${resource}`, { method: "POST", body: variables }) as never,
  }),

  update: async ({ resource, id, variables }) => ({
    data: await api(`/api/${resource}/${id}`, { method: "PATCH", body: variables }) as never,
  }),

  deleteOne: async ({ resource, id }) => ({
    data: await api(`/api/${resource}/${encodeURIComponent(String(id))}`, { method: "DELETE" }) as never,
  }),

  custom: async ({ url, method, payload, query }) => ({
    data: await api(url, { method: method.toUpperCase(), body: payload, query: query as never }) as never,
  }),
};
