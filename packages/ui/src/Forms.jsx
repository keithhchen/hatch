import React, { useId, useRef, useState } from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Check, FileUp, Search, X } from "lucide-react";
import { Button } from "./Button.jsx";
import { cn } from "./utils.js";

export function FormField({ label, hint, error, required = false, id, className, children }) {
  const generatedId = useId();
  const controlId = id || generatedId;
  const descriptionId = hint || error ? `${controlId}-description` : undefined;
  const control = React.isValidElement(children)
    ? React.cloneElement(children, {
        id: children.props.id || controlId,
        "aria-invalid": error ? true : children.props["aria-invalid"],
        "aria-describedby": children.props["aria-describedby"] || descriptionId
      })
    : children;
  return (
    <div className={cn("hui-field", error && "is-invalid", className)}>
      {label ? <LabelPrimitive.Root className="hui-field__label" htmlFor={controlId}>{label}{required ? <span aria-hidden="true"> *</span> : null}</LabelPrimitive.Root> : null}
      {control}
      {error ? <p className="hui-field__error" id={descriptionId}>{error}</p> : hint ? <p className="hui-field__hint" id={descriptionId}>{hint}</p> : null}
    </div>
  );
}

export const Input = React.forwardRef(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn("hui-input", className)} {...props} />;
});

export const Textarea = React.forwardRef(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn("hui-input hui-textarea", className)} {...props} />;
});

export const SearchInput = React.forwardRef(function SearchInput({ className, onClear, value, ...props }, ref) {
  return (
    <div className={cn("hui-search", className)}>
      <Search aria-hidden="true" />
      <input ref={ref} value={value} {...props} aria-label={props["aria-label"] ?? "Search"} />
      {onClear && value ? <button type="button" aria-label="Clear search" onClick={onClear}><X aria-hidden="true" /></button> : null}
    </div>
  );
});

export function Checkbox({ label, description, className, ...props }) {
  const id = useId();
  return (
    <div className={cn("hui-choice", className)}>
      <CheckboxPrimitive.Root className="hui-checkbox" id={id} {...props}>
        <CheckboxPrimitive.Indicator><Check aria-hidden="true" /></CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <LabelPrimitive.Root htmlFor={id}><strong>{label}</strong>{description ? <span>{description}</span> : null}</LabelPrimitive.Root>
    </div>
  );
}

export function RadioGroup({ value, defaultValue, onValueChange, options, label, className }) {
  const groupId = useId();
  return (
    <RadioGroupPrimitive.Root className={cn("hui-radio-group", className)} value={value} defaultValue={defaultValue} onValueChange={onValueChange} aria-label={label}>
      {options.map((option) => {
        const id = `${groupId}-${option.value}`;
        return <div className="hui-choice" key={option.value}><RadioGroupPrimitive.Item className="hui-radio" value={option.value} id={id} disabled={option.disabled}><RadioGroupPrimitive.Indicator /></RadioGroupPrimitive.Item><LabelPrimitive.Root htmlFor={id}><strong>{option.label}</strong>{option.description ? <span>{option.description}</span> : null}</LabelPrimitive.Root></div>;
      })}
    </RadioGroupPrimitive.Root>
  );
}

export function Switch({ label, description, className, ...props }) {
  const id = useId();
  return (
    <div className={cn("hui-switch-row", className)}>
      <LabelPrimitive.Root htmlFor={id}><strong>{label}</strong>{description ? <span>{description}</span> : null}</LabelPrimitive.Root>
      <SwitchPrimitive.Root className="hui-switch" id={id} {...props}><SwitchPrimitive.Thumb /></SwitchPrimitive.Root>
    </div>
  );
}

export function FileUploader({ accept, multiple = false, disabled = false, onFiles, label = "Choose files", hint, className }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  function commit(files) {
    const list = Array.from(files || []);
    if (list.length) onFiles?.(list);
    if (inputRef.current) inputRef.current.value = "";
  }
  return (
    <div
      className={cn("hui-dropzone", dragging && "is-dragging", disabled && "is-disabled", className)}
      onDragEnter={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); if (!disabled) commit(event.dataTransfer.files); }}
    >
      <FileUp aria-hidden="true" />
      <strong>{label}</strong>
      {hint ? <span>{hint}</span> : null}
      <Button type="button" variant="secondary" size="small" disabled={disabled} onClick={() => inputRef.current?.click()}>Browse</Button>
      <input ref={inputRef} className="hui-visually-hidden" type="file" accept={accept} multiple={multiple} disabled={disabled} aria-label={label} onChange={(event) => commit(event.target.files)} />
    </div>
  );
}

export function DatePicker({ value, onChange, label = "Choose a date", disabled, className, ...props }) {
  const normalized = value instanceof Date && !Number.isNaN(value.valueOf())
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
    : typeof value === "string" ? value.slice(0, 10) : "";
  return <input
    {...props}
    className={cn("hui-input hui-date-input", className)}
    type="date"
    aria-label={props["aria-label"] ?? label}
    value={normalized}
    disabled={disabled}
    onChange={(event) => {
      const [year, month, day] = event.target.value.split("-").map(Number);
      onChange?.(event.target.value ? new Date(year, month - 1, day) : undefined, event);
    }}
  />;
}
