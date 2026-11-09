import { type ReactNode, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Dialog for a form. Closing with unsaved edits asks first; a successful save closes through `onOpenChange(false)`
 * directly, so it never triggers the discard prompt.
 */
export function FormDialog({
  open,
  onOpenChange,
  dirty,
  title,
  description,
  size,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dirty: boolean;
  title: string;
  description?: ReactNode;
  size?: "form" | "confirm";
  children: ReactNode;
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (!next && dirty ? setConfirmDiscard(true) : onOpenChange(next))}>
        <DialogContent size={size}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
          </DialogHeader>
          {children}
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>The changes in “{title}” have not been saved.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction destructive onClick={() => onOpenChange(false)}>
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Collects react-hook-form errors (plus a server error) into the list shown by <FormErrors>. */
export function errorList(errors: Record<string, { message?: unknown } | undefined>, server?: string | null) {
  const list = Object.values(errors)
    .map((e) => (typeof e?.message === "string" ? e.message : null))
    .filter((m): m is string => !!m);
  return server ? [...list, server] : list;
}
