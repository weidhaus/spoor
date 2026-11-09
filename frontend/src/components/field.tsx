import { type ReactNode, useId } from "react";

import { Label } from "@/components/ui/label";

/** Persistent label, optional helper text and an associated error. The control receives the ids via render prop. */
export function Field({
  label,
  required,
  helper,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  helper?: ReactNode;
  error?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean; "aria-required"?: boolean }) => ReactNode;
}) {
  const id = useId();
  const helperId = helper ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="text-fg-secondary"> (required)</span> : null}
      </Label>
      {children({
        id,
        "aria-describedby": [helperId, errorId].filter(Boolean).join(" ") || undefined,
        "aria-invalid": error ? true : undefined,
        "aria-required": required || undefined,
      })}
      {helper && (
        <p id={helperId} className="text-xs text-fg-muted">
          {helper}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-failure-fg">
          {error}
        </p>
      )}
    </div>
  );
}

/** Form-level summary shown when submission fails with more than one error, or with a server error. */
export function FormErrors({ errors, id }: { errors: string[]; id?: string }) {
  if (!errors.length) return null;
  return (
    <div id={id} role="alert" tabIndex={-1} className="rounded-md border border-failure-border bg-failure-bg px-3 py-2 text-sm text-failure-fg">
      {errors.length === 1 ? (
        errors[0]
      ) : (
        <>
          <p className="font-semibold">Fix {errors.length} problems before saving:</p>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
