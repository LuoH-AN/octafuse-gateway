'use client';

import { useId, type ReactNode } from 'react';

export type ChoiceCardOption = {
	value: string;
	title: string;
	description?: ReactNode;
	detail?: ReactNode;
	disabled?: boolean;
};

/** Native radios provide one selection, arrow-key navigation and a full-card hit area. */
export function ChoiceCards({ label, value, options, onChange, disabled = false }: {
	label: string;
	value: string;
	options: ChoiceCardOption[];
	onChange: (value: string) => void;
	disabled?: boolean;
}) {
	const id = useId();
	return (
		<fieldset disabled={disabled} className="min-w-0">
			<legend className="sr-only">{label}</legend>
			<div className="grid gap-2 sm:grid-cols-2">
				{options.map((option, index) => (
					<label key={option.value} className="md-choice-card relative flex min-w-0 cursor-pointer items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
						<input type="radio" name={id} value={option.value} checked={value === option.value}
							disabled={option.disabled} onChange={() => onChange(option.value)}
							aria-labelledby={`${id}-${index}-title`}
							aria-describedby={option.description ? `${id}-${index}-description` : undefined}
							className="mt-0.5 h-4 w-4 shrink-0" />
						<span className="min-w-0 flex-1">
							<span id={`${id}-${index}-title`} className="block text-sm font-medium text-gray-900">{option.title}</span>
							{option.description ? <span id={`${id}-${index}-description`} className="mt-1 block text-xs leading-5 text-gray-500">{option.description}</span> : null}
							{option.detail ? <span className="mt-2 block break-words text-xs text-gray-600">{option.detail}</span> : null}
						</span>
					</label>
				))}
			</div>
		</fieldset>
	);
}
