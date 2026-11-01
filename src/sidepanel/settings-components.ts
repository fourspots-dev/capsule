import { escapeHtml } from './html';

export interface SettingsSubpageOptions {
  title: string;
  body: string;
  theme: 'light' | 'dark';
  backAction?: string;
  backLabel?: string;
  backIcon: string;
}

export interface SettingsGroupOptions {
  label: string;
  content: string;
  cardClassName?: string;
}

export interface SettingsRowOptions {
  label: string;
  icon?: string;
  value?: string;
  control?: string;
  action?: string;
  ariaLabel?: string;
  className?: string;
  destructive?: boolean;
}

export interface SettingsSelectRowOptions {
  label: string;
  icon?: string;
  value?: string;
  action?: string;
  control?: string;
}

export interface SettingsFieldOptions {
  label: string;
  control: string;
  className?: string;
  controlFirst?: boolean;
}

export interface SettingsFormOptions {
  id?: string;
  content: string;
  className?: string;
}

export function settingsSubpage({
  title,
  body,
  theme,
  backAction = 'back',
  backLabel = 'Back',
  backIcon,
}: SettingsSubpageOptions): string {
  return `<div id="kernel-page-layer" class="kernel-page-layer">
    <div class="wb-stage" data-wb-theme="${theme}" style="--wb-page-rgb: 83,177,255; --wb-dock-h: 160px;">
      ${settingsHeader(title, backAction, backLabel, backIcon)}
      <div class="wb-settings-body">${body}</div>
      <div class="wb-fx-grain"></div>
      <div class="wb-fx-scan"></div>
    </div>
  </div>`;
}

export function settingsGroup({
  label,
  content,
  cardClassName,
}: SettingsGroupOptions): string {
  return `<div class="wb-set-group">
    <div class="wb-set-group-label">${escapeHtml(label)}</div>
    ${settingsCard(content, cardClassName)}
  </div>`;
}

export function settingsCard(content: string, className = ''): string {
  return `<div class="${joinClasses('wb-set-card', className)}">${content}</div>`;
}

export function settingsRow({
  label,
  icon,
  value,
  control,
  action,
  ariaLabel,
  className,
  destructive,
}: SettingsRowOptions): string {
  const tag = action ? 'button' : 'div';
  const attributes = [
    action ? 'type="button"' : '',
    action ? `data-page-action="${escapeHtml(action)}"` : '',
    ariaLabel ? `aria-label="${escapeHtml(ariaLabel)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const classes = joinClasses(
    'wb-set-row',
    action ? 'wb-set-navrow wb-clickable' : '',
    destructive ? 'kernel-danger-row' : '',
    className
  );
  const trailing = control
    ? `<span class="wb-input-grow"></span>${control}`
    : value !== undefined
      ? `<span class="wb-input-grow"></span><span class="wb-set-row-value">${escapeHtml(value)}</span>${action ? chevron() : ''}`
      : action
        ? `<span class="wb-input-grow"></span>${chevron()}`
        : '';
  return `<${tag}${attributes ? ` ${attributes}` : ''} class="${classes}">${settingsRowLabel(label, icon)}${trailing}</${tag}>`;
}

export function settingsNavRow(
  options: Omit<SettingsRowOptions, 'action'> & { action: string }
): string {
  return settingsRow(options);
}

export function settingsSelectRow({
  label,
  icon,
  value,
  action,
  control,
}: SettingsSelectRowOptions): string {
  const trailing =
    control ??
    (action
      ? `<button type="button" class="wb-set-select" data-page-action="${escapeHtml(action)}"><span class="wb-set-select-value">${escapeHtml(value ?? '')}</span>${chevron()}</button>`
      : `<span class="wb-set-select-value">${escapeHtml(value ?? '')}</span>`);
  return `<div class="wb-set-row wb-set-selectrow">${settingsRowLabel(label, icon)}${trailing}</div>`;
}

export function settingsField({
  label,
  control,
  className,
  controlFirst = false,
}: SettingsFieldOptions): string {
  return `<label${className ? ` class="${escapeHtml(className)}"` : ''}>${controlFirst ? control : ''}${escapeHtml(label)}${controlFirst ? '' : control}</label>`;
}

export function settingsForm({
  id,
  content,
  className,
}: SettingsFormOptions): string {
  return `<form${id ? ` id="${escapeHtml(id)}"` : ''} class="${joinClasses('wb-form', className)}">${content}</form>`;
}

export function settingsSeparator(): string {
  return '<div class="wb-set-sepa"></div>';
}

function settingsHeader(
  title: string,
  action: string,
  backLabel: string,
  backIcon: string
): string {
  return `<div class="wb-settings-head">
    <button type="button" class="wb-icon-button wb-settings-back" data-page-action="${escapeHtml(action)}" aria-label="${escapeHtml(backLabel)}">${backIcon}</button>
    <div class="wb-settings-title">${escapeHtml(title)}</div>
  </div>`;
}

function settingsRowLabel(label: string, icon?: string): string {
  return `<span class="wb-set-row-label">${icon ? `<span class="wb-set-row-icon">${icon}</span>` : ''}${escapeHtml(label)}</span>`;
}

function chevron(): string {
  return "<svg viewBox='0 0 18 18' fill='none' aria-hidden='true' class='wb-set-select-chevron'><path fill-rule='evenodd' clip-rule='evenodd' d='M8.54 12.54a.7.7 0 0 0 .96 0l5.23-5.24a.7.7 0 1 0-.96-.96L9.02 11.1 4.23 6.35a.7.7 0 0 0-.96.96z' fill='currentColor'/></svg>";
}

function joinClasses(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}
