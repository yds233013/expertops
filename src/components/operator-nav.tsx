'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { clsx } from 'clsx';

/**
 * The operator navigation.
 *
 * Sixteen destinations wrapped onto two rows in a top bar, which made the most
 * important number on the screen — how much is waiting on a person — just
 * another item in a hedge. They are grouped into five sections down the side
 * instead, so a destination has a neighbourhood and the eye has somewhere to
 * start.
 *
 * One component renders both the desktop rail and the mobile sheet, because two
 * implementations of the same menu drift the moment a destination is added.
 */
export interface NavItem {
  href: string;
  label: string;
}

export interface NavGroup {
  heading: string;
  items: NavItem[];
}

function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  // A detail page keeps its section lit: /projects/abc belongs to /projects.
  return pathname.startsWith(`${href}/`);
}

function NavLinks({
  groups,
  badges,
  pathname,
  onNavigate,
}: {
  groups: NavGroup[];
  badges: Record<string, number>;
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <>
      {groups.map((group) => (
        <div key={group.heading} className="mb-5 last:mb-0">
          <h2 className="nav-heading">{group.heading}</h2>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              const count = badges[item.href] ?? 0;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={clsx('nav-link', active && 'nav-link-active')}
                  >
                    <span className="truncate">{item.label}</span>
                    {count > 0 && (
                      <span className="nav-count" aria-label={`${count} waiting`}>
                        {count}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

export function OperatorNav({
  groups,
  badges,
  total,
}: {
  groups: NavGroup[];
  badges: Record<string, number>;
  /** Everything waiting on a person, shown on the mobile button. */
  total: number;
}) {
  const pathname = usePathname() ?? '';
  const [open, setOpen] = useState(false);
  const panelId = useId();

  // A menu that survives navigation covers the page it just opened.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {/* Desktop rail. */}
      <nav aria-label="Sections" className="hidden lg:block">
        <NavLinks groups={groups} badges={badges} pathname={pathname} />
      </nav>

      {/* Mobile trigger. */}
      <div className="lg:hidden">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true" className="leading-none">
            {open ? '✕' : '☰'}
          </span>
          Menu
          {total > 0 && !open && <span className="nav-count">{total}</span>}
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close the menu"
            tabIndex={-1}
            className="absolute inset-0 bg-navy-900/50"
            onClick={() => setOpen(false)}
          />
          <nav
            id={panelId}
            aria-label="Sections"
            className="nav-sheet absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto px-4 py-4 shadow-lg"
          >
            <NavLinks
              groups={groups}
              badges={badges}
              pathname={pathname}
              onNavigate={() => setOpen(false)}
            />
          </nav>
        </div>
      )}
    </>
  );
}
