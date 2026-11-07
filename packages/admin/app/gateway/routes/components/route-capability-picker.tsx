'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChoiceCards, type ChoiceCardOption } from '@/components/choice-cards';
import { EditorDisclosure } from '@/components/editor-disclosure';
import { adapterOptionMappingSuffix, type AdapterOptionAvailability } from '../route-utils';

export function RouteCapabilityPicker({ options, value, onChange, editing, legacyValue }: {
	options: AdapterOptionAvailability[];
	value: string | null;
	onChange: (value: string) => void;
	editing: boolean;
	legacyValue?: string;
}) {
	const t = useTranslations('routes.modal');
	const [query, setQuery] = useState('');
	const choices: ChoiceCardOption[] = options.map(({ descriptor, available }) => {
		const key = descriptor.labelKey ?? descriptor.id;
		return {
			value: descriptor.optionKey,
			title: `${t.has(`adapterNames.${key}`) ? t(`adapterNames.${key}`) : descriptor.id}${available ? '' : ` · ${t('adapterUnavailable')}`}`,
			description: t.has(`adapterGuides.${descriptor.id}.purpose`) ? t(`adapterGuides.${descriptor.id}.purpose`) : t('editor.adapterHint'),
			detail: adapterOptionMappingSuffix(descriptor).replace(/^ · /, ''),
			disabled: !available && descriptor.optionKey !== value,
		};
	});
	if (legacyValue) choices.push({ value: legacyValue, title: `${legacyValue} · ${t('currentLegacyValue')}` });
	const selected = choices.find((choice) => choice.value === (value ?? legacyValue));
	const normalized = query.trim().toLocaleLowerCase();
	const filtered = choices.filter((choice) =>
		[choice.title, choice.description, choice.detail].some((text) => typeof text === 'string' && text.toLocaleLowerCase().includes(normalized)));
	return (
		<EditorDisclosure title={t('workflow.capability')} summary={selected ? <>{selected.title}<span className="block break-words">{selected.detail}</span></> : t('workflow.chooseCapability')}
			defaultOpen={!editing || !selected}>
			<p className="mb-3 text-xs leading-5 text-gray-500">{t('workflow.capabilityHint')}</p>
			{choices.length > 6 ? <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
				aria-label={t('workflow.searchCapabilities')} placeholder={t('workflow.searchCapabilities')}
				className="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" /> : null}
			{filtered.length ? <ChoiceCards label={t('adapter')} value={value ?? legacyValue ?? ''} options={filtered} onChange={onChange} />
				: <p role="status" className="py-4 text-sm text-gray-500">{t(choices.length ? 'workflow.noCapabilities' : 'noCompatibleAdapter')}</p>}
		</EditorDisclosure>
	);
}
