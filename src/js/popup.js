ACTIONS.forEach((action) => {
    document.querySelectorAll(`.${action.cls}`).forEach((elt) => {
        elt.addEventListener('click', (event) => {
            action.callback();
        });
    });
});
