import DashboardLayout from '@/Layouts/DashboardLayout';

export default function Sales() {
    const menuItems = [
        { label: 'Leads', href: '#' },
        { label: 'Quotes', href: '#' },
        { label: 'Customers', href: '#' },
        { label: 'Invoices', href: '#' },
    ];

    return (
        <DashboardLayout title="Sales Dashboard" roleLabel="Sales" menuItems={menuItems}>
            <p className="text-sm text-slate-600">
                Track pipeline, manage customers, and monitor revenue performance.
            </p>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">New Leads</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">28</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">Quotes Awaiting</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">12</div>
                </div>
            </div>
        </DashboardLayout>
    );
}
