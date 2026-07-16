import { Head, Link, usePage } from '@inertiajs/react';

export default function DashboardLayout({ title, roleLabel, menuItems, children }) {
    const { props } = usePage();
    const user = props.auth?.user;

    const items = menuItems.map((item) => ({
        ...item,
        isActive: item.name ? route().current(item.name) : false,
    }));

    return (
        <div className="min-h-screen bg-slate-50 text-slate-900">
            <Head title={title} />

            <header className="border-b border-slate-200 bg-white">
                <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
                    <div>
                        <div className="text-lg font-semibold">{user?.name}</div>
                        <div className="text-xs uppercase tracking-wide text-slate-500">{roleLabel}</div>
                    </div>
                    <div className="hidden text-sm text-slate-600 sm:block">{title}</div>
                </div>
            </header>

            <main className="mx-auto max-w-6xl px-6 py-10">
                <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
                    <aside className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Modules
                        </div>
                        <nav className="space-y-2">
                            {items.map((item) => (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition ${
                                        item.isActive
                                            ? 'bg-indigo-50 text-indigo-700'
                                            : 'text-slate-700 hover:bg-slate-100'
                                    }`}
                                >
                                    <span>{item.label}</span>
                                    {item.badge && (
                                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                                            {item.badge}
                                        </span>
                                    )}
                                </Link>
                            ))}
                        </nav>
                    </aside>

                    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                        <div className="mb-6">
                            <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
                            <p className="mt-1 text-sm text-slate-500">Welcome back, {user?.name}.</p>
                        </div>
                        {children}
                    </section>
                </div>
            </main>
        </div>
    );
}
