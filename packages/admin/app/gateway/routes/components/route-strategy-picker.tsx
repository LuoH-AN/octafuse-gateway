'use client';

import { useTranslations } from 'next-intl';
import { ChoiceCards } from '@/components/choice-cards';
import { EditorDisclosure } from '@/components/editor-disclosure';
import { ROUTE_STRATEGY_META_LIST } from '../route-strategy-meta';
import { RouteStrategyDiagram } from './route-strategy-diagram';

export type RouteStrategyPickerProps = {
	/** Currently selected strategy id, or '' for inherit. */
	value: string;
	onChange: (value: string) => void;
	/** When set, empty selection highlights the inherited strategy. */
	allowInherit?: boolean;
	inheritedStrategy?: string;
	/** @deprecated Kept for call-site compatibility; no longer shown in the picker. */
	inheritedSourceLabel?: string;
	disabled?: boolean;
	className?: string;
	/** Compact density for Config page. */
	dense?: boolean;
};

export function RouteStrategyPicker({ value, onChange, allowInherit = false, inheritedStrategy, disabled = false, className }: RouteStrategyPickerProps) {
	const t = useTranslations('routes.strategy');
	const effective = value || (allowInherit ? inheritedStrategy : '');
	const selected = ROUTE_STRATEGY_META_LIST.find((meta) => meta.id === effective);
	const inheritedLabel = inheritedStrategy && t.has(`display.${inheritedStrategy}`)
		? t(`display.${inheritedStrategy}`) : inheritedStrategy || '—';

	return (
		<div className={className}>
			<ChoiceCards label={t('title')} value={value} onChange={onChange} disabled={disabled}
				options={[
					...(allowInherit ? [{ value: '', title: t('followInherited'), description: t('inheritedChoice', { strategy: inheritedLabel }) }] : []),
					...ROUTE_STRATEGY_META_LIST.map((meta) => ({
						value: meta.id,
						title: t(`display.${meta.id}`),
						description: t(`description.${meta.id}.summary`),
					})),
				]} />
			{selected ? (
				<EditorDisclosure className="mt-3" title={t('guideTitle')}
					summary={`${t('effective')} · ${t(`display.${selected.id}`)}`}>
					<div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_240px]">
						<div className="space-y-2 text-xs leading-5 text-gray-600">
							<p><span className="font-medium">{t('bestFor')}{t('labelSeparator')}</span>{t(`description.${selected.id}.bestFor`)}</p>
							<p><span className="font-medium">{t('tradeoff')}{t('labelSeparator')}</span>{t(`description.${selected.id}.tradeoff`)}</p>
							<p>{t('priorityFirst')}</p>
						</div>
						<RouteStrategyDiagram kind={selected.diagram} caption={t(`diagramCaption.${selected.id}`)} />
					</div>
				</EditorDisclosure>
			) : null}
		</div>
	);
}
