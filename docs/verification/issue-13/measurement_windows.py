"""Conservative bounds; point observations never masquerade as commit times."""


def latency_window(publication, judgment):
    if publication is None or judgment is None:
        return None
    plo, phi = publication
    jlo, jhi = judgment
    if plo > phi or jlo > jhi:
        raise ValueError('Invalid transaction observation interval')
    return dict(lower_seconds=max(0, jlo - phi), upper_seconds=jhi - plo,
                publication_window=[plo, phi], judgment_window=[jlo, jhi],
                observed_difference_seconds=jhi - phi)
