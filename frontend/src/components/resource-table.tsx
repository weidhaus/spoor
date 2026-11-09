import type { BaseRecord, HttpError } from "@refinedev/core";
import type { UseTableReturnType } from "@refinedev/react-table";
import { type ColumnDef, type RowData, flexRender } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Search } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { ErrorPanel } from "@/components/panels";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    align?: "right";
    minWidth?: number;
  }
}

export type TableModel<T extends BaseRecord> = UseTableReturnType<T, HttpError>;

const PAGE_SIZES = [25, 50, 100];

/** Filters live in TanStack's column-filter state, which @refinedev/react-table syncs into Refine (and the URL). */
export function useFilters<T extends BaseRecord>(table: TableModel<T>) {
  const { reactTable } = table;
  const state = reactTable.getState().columnFilters;
  return {
    value: (id: string) => (state.find((f) => f.id === id)?.value as string | undefined) ?? "",
    set: (id: string, value: string) =>
      reactTable.setColumnFilters((prev) => [...prev.filter((f) => f.id !== id), ...(value ? [{ id, value }] : [])]),
    clear: () => reactTable.setColumnFilters([]),
    active: state.some((f) => f.value !== undefined && f.value !== ""),
  };
}

/** Selection checkbox column; selection always covers the current page only. */
export function selectColumn<T extends BaseRecord>(rowLabel: (row: T) => string): ColumnDef<T> {
  return {
    id: "select",
    enableSorting: false,
    meta: { minWidth: 44 },
    header: ({ table }) => (
      <Checkbox
        aria-label="Select all rows on this page"
        checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? "indeterminate" : false}
        onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        aria-label={`Select ${rowLabel(row.original)}`}
        checked={row.getIsSelected()}
        onCheckedChange={(v) => row.toggleSelected(!!v)}
      />
    ),
  };
}

export function SearchFilter<T extends BaseRecord>({ table, label, id = "q" }: { table: TableModel<T>; label: string; id?: string }) {
  const filters = useFilters(table);
  const current = filters.value(id);
  const [text, setText] = useState(current);
  const [synced, setSynced] = useState(current);
  const inputId = useId();
  if (current !== synced) {
    // The filter changed elsewhere (Clear filters, back button): adopt it. Adjusting state during render, not in an effect.
    setSynced(current);
    setText(current);
  }
  useEffect(() => {
    if (text === current) return;
    const t = setTimeout(() => filters.set(id, text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex min-w-[220px] flex-1 flex-col gap-2 md:max-w-sm">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-muted" strokeWidth={1.75} aria-hidden />
        <Input id={inputId} type="search" value={text} onChange={(e) => setText(e.target.value)} className="pl-9" />
      </div>
    </div>
  );
}

export function SelectFilter<T extends BaseRecord>({
  table,
  id,
  label,
  options,
  allLabel = "All",
}: {
  table: TableModel<T>;
  id: string;
  label: string;
  options: [value: string, label: string][];
  allLabel?: string;
}) {
  const filters = useFilters(table);
  const selectId = useId();
  return (
    <div className="flex min-w-[180px] flex-col gap-2">
      <Label htmlFor={selectId}>{label}</Label>
      <Select value={filters.value(id) || "__all"} onValueChange={(v) => filters.set(id, v === "__all" ? "" : v)}>
        <SelectTrigger id={selectId} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">{allLabel}</SelectItem>
          {options.map(([value, text]) => (
            <SelectItem key={value} value={value}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ResourceTable<T extends BaseRecord>({
  table,
  label,
  emptyTitle,
  emptyHint,
  filters: filterControls,
  selectionActions,
}: {
  table: TableModel<T>;
  /** Accessible name of the scroll region and the noun used in status messages, e.g. "Applications". */
  label: string;
  /** Shown when nothing exists at all (no filters applied). */
  emptyTitle: string;
  emptyHint?: ReactNode;
  filters?: ReactNode;
  /** Rendered when rows are selected; receives the exact selected record ids. */
  selectionActions?: (ids: string[], clear: () => void) => ReactNode;
}) {
  const { reactTable, refineCore } = table;
  const { tableQuery, currentPage, setCurrentPage, pageSize, setPageSize, pageCount } = refineCore;
  const filters = useFilters(table);
  const total = tableQuery.data?.total;
  const rows = reactTable.getRowModel().rows;
  const selectedIds = Object.keys(reactTable.getState().rowSelection).filter((k) => reactTable.getState().rowSelection[k]);
  const liveRegion = useRef<HTMLParagraphElement>(null);

  // Changing page or filters clears page-only selection, and says so.
  const scopeKey = `${currentPage}|${JSON.stringify(refineCore.filters)}|${pageSize}`;
  const lastScope = useRef(scopeKey);
  useEffect(() => {
    if (lastScope.current === scopeKey) return;
    lastScope.current = scopeKey;
    if (Object.keys(reactTable.getState().rowSelection).length) {
      reactTable.resetRowSelection();
      if (liveRegion.current) liveRegion.current.textContent = "Selection cleared because the page or filters changed.";
    }
  }, [scopeKey, reactTable]);

  const firstLoad = tableQuery.isLoading;
  const hardError = tableQuery.isError && !tableQuery.data;
  const columns = reactTable.getVisibleLeafColumns().length;

  return (
    <div className="flex flex-col gap-4">
      {filterControls && (
        <div className="flex flex-wrap items-end gap-4">
          {filterControls}
          {filters.active && (
            <Button variant="ghost" onClick={filters.clear}>
              Clear filters
            </Button>
          )}
        </div>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {firstLoad ? `Loading ${label.toLowerCase()}` : ""}
      </p>
      <p ref={liveRegion} role="status" aria-live="polite" className="sr-only" />

      {tableQuery.isError && tableQuery.data && (
        <ErrorPanel
          title="Could not refresh"
          message={`Showing results last loaded at ${formatDateTime(new Date(tableQuery.dataUpdatedAt).toISOString())}. ${tableQuery.error?.message ?? ""}`}
          onRetry={() => tableQuery.refetch()}
        />
      )}

      {hardError ? (
        <ErrorPanel message={tableQuery.error?.message} onRetry={() => tableQuery.refetch()} />
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          {selectionActions && selectedIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-b border-line bg-selected px-3 py-2">
              <span className="text-sm font-medium text-selected-fg">
                {formatNumber(selectedIds.length)} selected on this page
              </span>
              <span className="text-xs text-fg-secondary">
                Selection covers this page only; selecting every matching record is not supported.
              </span>
              <div className="flex flex-wrap items-center gap-2 md:ml-auto">
                {selectionActions(selectedIds, () => reactTable.resetRowSelection())}
                <Button variant="ghost" size="sm" onClick={() => reactTable.resetRowSelection()}>
                  Clear selection
                </Button>
              </div>
            </div>
          )}
          <div role="region" aria-label={`${label} table`} tabIndex={0} className="relative overflow-x-auto rounded-lg">
            <Table aria-busy={tableQuery.isFetching || undefined}>
              <TableHeader>
                {reactTable.getHeaderGroups().map((group) => (
                  <TableRow key={group.id}>
                    {group.headers.map((header) => {
                      const sortable = header.column.getCanSort();
                      const dir = header.column.getIsSorted();
                      const meta = header.column.columnDef.meta;
                      return (
                        <TableHead
                          key={header.id}
                          style={{ minWidth: meta?.minWidth }}
                          className={cn(meta?.align === "right" && "text-right")}
                          aria-sort={sortable ? (dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none") : undefined}
                        >
                          {header.isPlaceholder ? null : sortable ? (
                            <button
                              type="button"
                              onClick={header.column.getToggleSortingHandler()}
                              className={cn(
                                "inline-flex min-h-8 cursor-pointer items-center gap-1 rounded-sm text-xs font-medium text-fg-secondary hover:text-fg",
                                meta?.align === "right" && "flex-row-reverse"
                              )}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              {dir === "asc" ? (
                                <ArrowUp className="size-3.5" aria-hidden />
                              ) : dir === "desc" ? (
                                <ArrowDown className="size-3.5" aria-hidden />
                              ) : (
                                <ArrowUpDown className="size-3.5 opacity-60" aria-hidden />
                              )}
                              <span className="sr-only">
                                {dir === "asc" ? ", sorted ascending" : dir === "desc" ? ", sorted descending" : ", not sorted"}
                              </span>
                            </button>
                          ) : (
                            flexRender(header.column.columnDef.header, header.getContext())
                          )}
                        </TableHead>
                      );
                    })}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {firstLoad ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <TableRow key={i} aria-hidden>
                      {Array.from({ length: columns }).map((__, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-full max-w-40" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns} className="h-auto py-10">
                      <div className="mx-auto flex max-w-md flex-col items-center gap-2 text-center">
                        {filters.active ? (
                          <>
                            <p className="text-base font-semibold text-fg">No {label.toLowerCase()} match these filters</p>
                            <p className="text-sm text-fg-secondary">Other records exist; change or clear the filters to see them.</p>
                            <Button variant="outline" onClick={filters.clear}>
                              Clear filters
                            </Button>
                          </>
                        ) : (
                          <>
                            <p className="text-base font-semibold text-fg">{emptyTitle}</p>
                            {emptyHint && <div className="text-sm text-fg-secondary">{emptyHint}</div>}
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id} data-state={row.getIsSelected() ? "selected" : undefined}>
                      {row.getVisibleCells().map((cell) => {
                        const meta = cell.column.columnDef.meta;
                        return (
                          <TableCell key={cell.id} className={cn(meta?.align === "right" && "tabular text-right")}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {!firstLoad && (total ?? 0) > 0 && (
            <nav aria-label={`${label} pagination`} className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-2">
              <p className="tabular text-sm text-fg-secondary">
                {total === undefined
                  ? "Total unknown"
                  : `${formatNumber((currentPage - 1) * pageSize + 1)}–${formatNumber(Math.min(currentPage * pageSize, total))} of ${formatNumber(total)}`}
                {tableQuery.isFetching && " · Updating…"}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <PageSize value={pageSize} onChange={setPageSize} />
                <span className="tabular text-sm text-fg-secondary">
                  Page {formatNumber(currentPage)} of {formatNumber(Math.max(pageCount, 1))}
                </span>
                <Button variant="outline" size="icon" aria-label="First page" disabled={currentPage <= 1} onClick={() => setCurrentPage(1)}>
                  <ChevronsLeft strokeWidth={1.75} />
                </Button>
                <Button variant="outline" size="icon" aria-label="Previous page" disabled={currentPage <= 1} onClick={() => setCurrentPage(currentPage - 1)}>
                  <ChevronLeft strokeWidth={1.75} />
                </Button>
                <Button variant="outline" size="icon" aria-label="Next page" disabled={currentPage >= pageCount} onClick={() => setCurrentPage(currentPage + 1)}>
                  <ChevronRight strokeWidth={1.75} />
                </Button>
                <Button variant="outline" size="icon" aria-label="Last page" disabled={currentPage >= pageCount} onClick={() => setCurrentPage(pageCount)}>
                  <ChevronsRight strokeWidth={1.75} />
                </Button>
              </div>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}

function PageSize({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="font-normal text-fg-secondary">
        Rows per page
      </Label>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger id={id} className="w-20">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PAGE_SIZES.map((n) => (
            <SelectItem key={n} value={String(n)}>
              {n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
