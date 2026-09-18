// A small context menu, operable with the keyboard, built without innerHTML

export interface MenuItem {
    label: string;
    /** Shortcut shown on the right */
    hint?: string;
    run(): void;
}

let open: { el: HTMLElement; close(): void } | undefined;

export function closeMenu() { open?.close(); }

export function openMenu(x: number, y: number, items: MenuItem[], returnFocus: HTMLElement) {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'menu';
    el.setAttribute('role', 'menu');
    const buttons = items.map(item => {
        const b = document.createElement('button');
        b.setAttribute('role', 'menuitem');
        b.tabIndex = -1;
        const label = document.createElement('span');
        label.textContent = item.label;
        b.append(label);
        if (item.hint) {
            const hint = document.createElement('span');
            hint.className = 'hint';
            hint.textContent = item.hint;
            b.append(hint);
        }
        b.addEventListener('click', () => { close(); item.run(); });
        el.append(b);
        return b;
    });
    document.body.append(el);
    // Keep the menu inside the panel
    el.style.left = `${Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth - 4))}px`;
    el.style.top = `${Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight - 4))}px`;

    const focusAt = (i: number) => buttons[(i + buttons.length) % buttons.length].focus();
    el.addEventListener('keydown', e => {
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        switch (e.key) {
            case 'ArrowDown': focusAt(i + 1); break;
            case 'ArrowUp': focusAt(i - 1); break;
            case 'Home': focusAt(0); break;
            case 'End': focusAt(-1); break;
            case 'Escape': case 'Tab': close(); returnFocus.focus(); break;
            default: return;
        }
        e.preventDefault();
        e.stopPropagation();
    });
    const outside = (e: Event) => { if (!el.contains(e.target as Node)) { close(); } };
    const onBlur = () => { if (!el.contains(document.activeElement)) { close(); } };
    setTimeout(() => {
        document.addEventListener('mousedown', outside, true);
        document.addEventListener('wheel', outside, true);
        window.addEventListener('blur', onBlur);
    });
    el.addEventListener('focusout', () => setTimeout(onBlur));
    function close() {
        if (open?.el !== el) { return; }
        open = undefined;
        document.removeEventListener('mousedown', outside, true);
        document.removeEventListener('wheel', outside, true);
        window.removeEventListener('blur', onBlur);
        el.remove();
    }
    open = { el, close };
    focusAt(0);
}
