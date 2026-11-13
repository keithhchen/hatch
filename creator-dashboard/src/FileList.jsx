import React, { useState } from "react";
import { IconButton, SearchInput, Spinner } from "@hatch/ui";
import { ChevronLeft, ChevronRight, FileText, RotateCw, Trash2 } from "lucide-react";
import { FILTER_FROM, groupFiles, pageGroups } from "./fileListModel.js";
import "./fileList.css";

const BUSY = new Set(["uploading", "ingesting"]);

/**
 * Every place a node shows files: compact rows grouped by folder, filterable, name column then actions column.
 * A record is `{ path, status?, error? }`; `status` is only set while the file is not settled.
 */
export function FileList({ title, records, onOpen, onDelete, onRetry, deletable = () => true, statusLabel, pageSize, thumbnail, t }) {
  const [query, setQuery] = useState("");
  const [pageAt, setPageAt] = useState(1);
  const all = groupFiles(records, query);
  const { groups, page, pages } = pageSize ? pageGroups(all, pageAt, pageSize) : { groups: all, page: 1, pages: 1 };
  return <section className="fl">
    {title || records.length >= FILTER_FROM ? <header className="fl__head">
      {title ? <strong>{title}</strong> : null}
      {records.length >= FILTER_FROM ? <SearchInput className="fl__search" value={query} onChange={event => { setQuery(event.target.value); setPageAt(1); }} onClear={() => { setQuery(""); setPageAt(1); }} placeholder={t("filterFiles")} aria-label={t("filterFiles")} /> : null}
    </header> : null}
    {groups.length ? groups.map(group => <div className="fl__group" key={group.folder}>
      {groups.length > 1 || group.folder ? <h4 className="fl__folder">{group.folder || t("filesRoot")}</h4> : null}
      <ul>{group.records.map(record => {
        const busy = BUSY.has(record.status);
        const failed = record.status === "failed" || record.status === "partial" || record.status === "unsupported";
        const openable = !record.status;
        return <li key={record.path} className={`fl__row${failed ? " is-failed" : ""}`}>
          <button type="button" className="fl__name" disabled={!openable} onClick={() => onOpen?.(record.path)} title={record.name}>
            {thumbnail?.(record) ? <img className="fl__thumb" src={thumbnail(record)} alt="" loading="lazy" /> : <FileText aria-hidden="true" />}
            <span className="fl__label">{record.name}</span>
            {record.status ? <small className="fl__state" title={record.error || undefined}>{[statusLabel?.(record), record.status === "uploading" ? `${Math.round((record.progress ?? 0) * 100)}%` : record.error].filter(Boolean).join(": ")}</small> : null}
          </button>
          <span className="fl__actions">
            {busy ? <Spinner label={statusLabel?.(record)} size="small" /> : null}
            {onRetry && record.retry ? <IconButton label={t("retryFile")} size="small" onClick={() => onRetry(record)}><RotateCw aria-hidden="true" /></IconButton> : null}
            {onDelete && !busy && deletable(record) ? <IconButton label={t("removeFile", record.path)} size="small" onClick={() => onDelete(record)}><Trash2 aria-hidden="true" /></IconButton> : null}
          </span>
        </li>;
      })}</ul>
    </div>) : <p className="fl__empty">{t("noFiles")}</p>}
    {pages > 1 ? <footer className="fl__pager">
      <IconButton className="fl__page" label={t("previousPage")} size="small" disabled={page <= 1} onClick={() => setPageAt(page - 1)}><ChevronLeft aria-hidden="true" /></IconButton>
      <span>{page}/{pages}</span>
      <IconButton className="fl__page" label={t("nextPage")} size="small" disabled={page >= pages} onClick={() => setPageAt(page + 1)}><ChevronRight aria-hidden="true" /></IconButton>
    </footer> : null}
  </section>;
}
