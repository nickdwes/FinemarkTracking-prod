import DashboardLayout from '@/Layouts/DashboardLayout';

export default function Technician() {
    const menuItems = [
        { label: 'Work Orders', href: '#' },
        { label: 'Inspections', href: '#' },
        { label: 'Maintenance Logs', href: '#' },
        { label: 'Parts Requests', href: '#' },
    ];

    return (
        <DashboardLayout title="Technician Dashboard" roleLabel="Technician" menuItems={menuItems}>
            <p className="text-sm text-slate-600">
                Manage field tasks, inspections, and service records.
            </p>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">Today's Jobs</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">4</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">Pending Reports</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">2</div>
                </div>
            </div>
        </DashboardLayout>
    );
}
