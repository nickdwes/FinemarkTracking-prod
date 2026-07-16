import DashboardLayout from '@/Layouts/DashboardLayout';

export default function TechnicalOfficer() {
    const menuItems = [
        { label: 'Pending Requests', href: route('technical.pending'), name: 'technical.pending' },
        { label: 'Assignment Form', href: route('technical.assign'), name: 'technical.assign' },
        { label: 'Assignments', href: route('technical.assignments'), name: 'technical.assignments' },
        { label: 'Stats', href: '#' },
    ];

    return (
        <DashboardLayout title="Technical Officer Dashboard" roleLabel="Technical Officer" menuItems={menuItems}>
            <p className="text-sm text-slate-600">
                Review technical work, approve outcomes, and manage escalations.
            </p>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">Pending Requests</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">--</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">Assignments in Progress</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">--</div>
                </div>
            </div>
        </DashboardLayout>
    );
}
