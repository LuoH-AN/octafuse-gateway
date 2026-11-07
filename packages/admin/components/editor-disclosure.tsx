'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';

/** Keep optional editor fields mounted so expanding never resets a draft. */
export function EditorDisclosure({ title, summary, children, defaultOpen = false, className = '' }: {
	title: string;
	summary?: ReactNode;
	children: ReactNode;
	defaultOpen?: boolean;
	className?: string;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const id = useId();
	return (
		<section className={`md-editor-disclosure min-w-0 rounded-xl border border-gray-200 bg-white ${className}`}>
			<button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
				className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left">
				<span className="min-w-0 flex-1">
					<span className="block text-sm font-medium text-gray-900">{title}</span>
					{summary ? <span className="mt-1 block text-xs leading-5 text-gray-500">{summary}</span> : null}
				</span>
				<ChevronDownIcon aria-hidden className={`h-4 w-4 shrink-0 text-gray-500 ${open ? 'rotate-180' : ''}`} />
			</button>
			<div id={id} hidden={!open} className="border-t border-gray-100 p-4">{children}</div>
		</section>
	);
}
