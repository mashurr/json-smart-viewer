document.querySelectorAll<HTMLElement>('.json-toggle').forEach(toggle => {
    toggle.dataset.collapsed = 'true';

    toggle.addEventListener('click', () => {
        const isCollapsed = toggle.dataset.collapsed === 'true';
        toggle.dataset.collapsed = isCollapsed ? 'false' : 'true';
    });
});
