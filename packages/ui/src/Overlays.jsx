import React, { useMemo, useState } from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Command as CommandPrimitive } from "cmdk";
import { Drawer as DrawerPrimitive } from "vaul";
import { Check, ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { Button, IconButton } from "./Button.jsx";
import { cn } from "./utils.js";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export const PopoverContent = React.forwardRef(function PopoverContent({ className, align = "center", sideOffset = 7, ...props }, ref) {
  return <PopoverPrimitive.Portal><PopoverPrimitive.Content ref={ref} className={cn("hui-popover", className)} align={align} sideOffset={sideOffset} {...props} /></PopoverPrimitive.Portal>;
});

export function TooltipProvider({ children, delayDuration = 380 }) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip({ children, content, side = "top" }) {
  return <TooltipPrimitive.Root><TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger><TooltipPrimitive.Portal><TooltipPrimitive.Content className="hui-tooltip" side={side} sideOffset={7}>{content}<TooltipPrimitive.Arrow className="hui-tooltip__arrow" /></TooltipPrimitive.Content></TooltipPrimitive.Portal></TooltipPrimitive.Root>;
}

export function DropdownMenu({ trigger, items, align = "end", label = "Actions" }) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content className="hui-menu" align={align} sideOffset={7} aria-label={label}>
          {items.map((item, index) => {
            if (item.type === "separator") return <DropdownMenuPrimitive.Separator className="hui-menu__separator" key={`separator-${index}`} />;
            if (item.type === "label") return <DropdownMenuPrimitive.Label className="hui-menu__label" key={`label-${index}`}>{item.label}</DropdownMenuPrimitive.Label>;
            if (item.children) return <DropdownMenuPrimitive.Sub key={item.value || item.label}><DropdownMenuPrimitive.SubTrigger className="hui-menu__item">{item.icon}<span>{item.label}</span><ChevronRight aria-hidden="true" /></DropdownMenuPrimitive.SubTrigger><DropdownMenuPrimitive.Portal><DropdownMenuPrimitive.SubContent className="hui-menu" sideOffset={6}>{item.children.map((child) => <DropdownMenuPrimitive.Item className="hui-menu__item" key={child.value || child.label} disabled={child.disabled} onSelect={child.onSelect}>{child.icon}<span>{child.label}</span></DropdownMenuPrimitive.Item>)}</DropdownMenuPrimitive.SubContent></DropdownMenuPrimitive.Portal></DropdownMenuPrimitive.Sub>;
            return <DropdownMenuPrimitive.Item className={cn("hui-menu__item", item.destructive && "is-destructive")} key={item.value || item.label} disabled={item.disabled} onSelect={item.onSelect}>{item.icon}<span>{item.label}</span>{item.shortcut ? <kbd>{item.shortcut}</kbd> : null}</DropdownMenuPrimitive.Item>;
          })}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export function Select({ value, defaultValue, onValueChange, options, placeholder = "Select…", label, disabled, className, ...triggerProps }) {
  return (
    <SelectPrimitive.Root value={value} defaultValue={defaultValue} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger {...triggerProps} className={cn("hui-select-trigger", className)} aria-label={label || triggerProps["aria-label"]}><SelectPrimitive.Value placeholder={placeholder} /><SelectPrimitive.Icon><ChevronDown aria-hidden="true" /></SelectPrimitive.Icon></SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="hui-select-content" position="popper" sideOffset={6}>
          <SelectPrimitive.Viewport>
            {options.map((option) => <SelectPrimitive.Item className="hui-select-item" value={option.value} disabled={option.disabled} key={option.value}><SelectPrimitive.ItemText className="hui-select-item__text">{option.label}</SelectPrimitive.ItemText><SelectPrimitive.ItemIndicator className="hui-select-item__indicator"><Check aria-hidden="true" /></SelectPrimitive.ItemIndicator></SelectPrimitive.Item>)}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function Combobox({ value, onValueChange, options, placeholder = "Choose…", searchPlaceholder = "Search…", empty = "No matches", label, className }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button className={cn("hui-combobox-trigger", className)} variant="secondary" aria-label={label} aria-expanded={open} trailing={<ChevronDown aria-hidden="true" />}>{selected?.label || placeholder}</Button></PopoverTrigger>
      <PopoverContent className="hui-command-popover" align="start">
        <CommandPrimitive className="hui-command">
          <div className="hui-command__search"><Search aria-hidden="true" /><CommandPrimitive.Input placeholder={searchPlaceholder} /></div>
          <CommandPrimitive.List><CommandPrimitive.Empty>{empty}</CommandPrimitive.Empty>{options.map((option) => <CommandPrimitive.Item key={option.value} value={`${option.label} ${option.value}`} disabled={option.disabled} onSelect={() => { onValueChange?.(option.value); setOpen(false); }}><Check className={cn(value !== option.value && "is-hidden")} aria-hidden="true" /><span>{option.label}</span></CommandPrimitive.Item>)}</CommandPrimitive.List>
        </CommandPrimitive>
      </PopoverContent>
    </Popover>
  );
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = React.forwardRef(function DialogContent({ title, description, children, footer, className, hideClose = false, ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="hui-overlay" />
      <DialogPrimitive.Content ref={ref} className={cn("hui-dialog", className)} {...props}>
        <header className="hui-dialog__header"><div><DialogPrimitive.Title>{title}</DialogPrimitive.Title>{description ? <DialogPrimitive.Description>{description}</DialogPrimitive.Description> : null}</div>{hideClose ? null : <DialogPrimitive.Close asChild><IconButton label="Close" size="small"><X aria-hidden="true" /></IconButton></DialogPrimitive.Close>}</header>
        <div className="hui-dialog__body">{children}</div>
        {footer ? <footer className="hui-dialog__footer">{footer}</footer> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

export function ConfirmDialog({ open, onOpenChange, trigger, title, description, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = false, busy = false, confirmDisabled = false, onConfirm, children }) {
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <AlertDialogPrimitive.Trigger asChild>{trigger}</AlertDialogPrimitive.Trigger> : null}
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="hui-overlay" />
        <AlertDialogPrimitive.Content className="hui-dialog hui-confirm-dialog">
          <AlertDialogPrimitive.Title>{title}</AlertDialogPrimitive.Title>
          {description ? <AlertDialogPrimitive.Description>{description}</AlertDialogPrimitive.Description> : null}
          {children ? <div className="hui-dialog__body">{children}</div> : null}
          <footer className="hui-dialog__footer"><AlertDialogPrimitive.Cancel asChild><Button variant="secondary">{cancelLabel}</Button></AlertDialogPrimitive.Cancel><Button variant={destructive ? "danger" : "primary"} loading={busy} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</Button></footer>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}

export function CommandMenu({ open, onOpenChange, groups, placeholder = "Search commands…", empty = "No commands found", title = "Commands" }) {
  const normalized = useMemo(() => groups || [], [groups]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="hui-overlay" />
        <DialogPrimitive.Content className="hui-command-dialog" aria-label={title}>
          <CommandPrimitive className="hui-command">
            <div className="hui-command__search"><Search aria-hidden="true" /><CommandPrimitive.Input autoFocus placeholder={placeholder} /><DialogPrimitive.Close asChild><IconButton label="Close" size="small"><X aria-hidden="true" /></IconButton></DialogPrimitive.Close></div>
            <CommandPrimitive.List><CommandPrimitive.Empty>{empty}</CommandPrimitive.Empty>{normalized.map((group) => <CommandPrimitive.Group heading={group.label} key={group.label}>{group.items.map((item) => <CommandPrimitive.Item key={item.value || item.label} value={`${item.label} ${item.keywords || ""}`} disabled={item.disabled} onSelect={() => { item.onSelect?.(); onOpenChange?.(false); }}>{item.icon}<span>{item.label}</span>{item.shortcut ? <kbd>{item.shortcut}</kbd> : null}</CommandPrimitive.Item>)}</CommandPrimitive.Group>)}</CommandPrimitive.List>
          </CommandPrimitive>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
  );
}

export function Drawer({ open, onOpenChange, trigger, title, description, children, footer, direction = "bottom" }) {
  return (
    <DrawerPrimitive.Root open={open} onOpenChange={onOpenChange} direction={direction}>
      {trigger ? <DrawerPrimitive.Trigger asChild>{trigger}</DrawerPrimitive.Trigger> : null}
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="hui-overlay" />
        <DrawerPrimitive.Content className={cn("hui-drawer", `is-${direction}`)}>
          <header className="hui-dialog__header"><div><DrawerPrimitive.Title>{title}</DrawerPrimitive.Title>{description ? <DrawerPrimitive.Description>{description}</DrawerPrimitive.Description> : null}</div><DrawerPrimitive.Close asChild><IconButton label="Close" size="small"><X aria-hidden="true" /></IconButton></DrawerPrimitive.Close></header>
          <div className="hui-drawer__body">{children}</div>
          {footer ? <footer className="hui-dialog__footer">{footer}</footer> : null}
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}

export function Sheet(props) {
  const { open, onOpenChange, trigger, title, description, children, footer } = props;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="hui-overlay" />
        <DialogPrimitive.Content className="hui-drawer is-right">
          <header className="hui-dialog__header"><div><DialogPrimitive.Title>{title}</DialogPrimitive.Title>{description ? <DialogPrimitive.Description>{description}</DialogPrimitive.Description> : null}</div><DialogPrimitive.Close asChild><IconButton label="Close" size="small"><X aria-hidden="true" /></IconButton></DialogPrimitive.Close></header>
          <div className="hui-drawer__body">{children}</div>
          {footer ? <footer className="hui-dialog__footer">{footer}</footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
