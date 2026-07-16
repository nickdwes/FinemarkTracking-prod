<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Api\AssignRequest;
use App\Http\Requests\Api\UpdateAssignmentStatusRequest;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class TechnicalController extends Controller
{
    private const STATUS_FLOW = [
        'pending' => ['assigned'],
        'assigned' => ['in_progress'],
        'in_progress' => ['completed'],
        'completed' => ['certified'],
        'certified' => [],
    ];

    public function pendingRequests(): JsonResponse
    {
        $requests = DB::table('installation_requests as ir')
            ->join('customers as c', 'c.id', '=', 'ir.customer_id')
            ->join('vehicles as v', 'v.id', '=', 'ir.vehicle_id')
            ->select([
                'ir.id',
                'ir.status',
                'ir.requested_at',
                'ir.preferred_date',
                'ir.location',
                'c.name as customer_name',
                'v.registration_number',
                'v.make',
                'v.model',
            ])
            ->where('ir.status', 'pending')
            ->orderByDesc('ir.requested_at')
            ->get();

        return $this->success(['items' => $requests]);
    }

    public function assignments(): JsonResponse
    {
        $assignments = DB::table('assignments as a')
            ->join('installation_requests as ir', 'ir.id', '=', 'a.installation_request_id')
            ->join('customers as c', 'c.id', '=', 'ir.customer_id')
            ->join('vehicles as v', 'v.id', '=', 'ir.vehicle_id')
            ->join('users as u', 'u.id', '=', 'a.assigned_to')
            ->select([
                'a.id',
                'a.status',
                'a.scheduled_at',
                'a.created_at',
                'u.name as technician_name',
                'ir.id as request_id',
                'c.name as customer_name',
                'v.registration_number',
            ])
            ->orderByDesc('a.created_at')
            ->get();

        return $this->success(['items' => $assignments]);
    }

    public function assign(AssignRequest $request, string $requestId): JsonResponse
    {
        $technician = User::query()
            ->where('id', $request->string('technician_id'))
            ->where('role', User::ROLE_TECHNICIAN)
            ->first();

        if (! $technician) {
            return $this->error('Technician not found.', 422);
        }

        $installationRequest = DB::table('installation_requests')
            ->where('id', $requestId)
            ->where('status', 'pending')
            ->first();

        if (! $installationRequest) {
            return $this->error('Installation request not found.', 404);
        }

        $assignmentId = (string) Str::uuid();

        DB::transaction(function () use ($request, $requestId, $assignmentId) {
            DB::table('assignments')->insert([
                'id' => $assignmentId,
                'installation_request_id' => $requestId,
                'assigned_to' => $request->string('technician_id'),
                'assigned_by' => $request->user()?->id,
                'status' => 'assigned',
                'scheduled_at' => $request->input('scheduled_at'),
                'notes' => $request->input('notes'),
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            DB::table('installation_requests')
                ->where('id', $requestId)
                ->update([
                    'status' => 'assigned',
                    'updated_at' => now(),
                ]);
        });

        return $this->success([
            'assignment_id' => $assignmentId,
        ], 201);
    }

    public function updateStatus(UpdateAssignmentStatusRequest $request, string $assignmentId): JsonResponse
    {
        $assignment = DB::table('assignments')->where('id', $assignmentId)->first();

        if (! $assignment) {
            return $this->error('Assignment not found.', 404);
        }

        $current = $assignment->status;
        $next = $request->string('status');

        $allowed = self::STATUS_FLOW[$current] ?? [];

        if (! in_array($next, $allowed, true)) {
            return $this->error('Invalid status transition.', 422, [
                'from' => $current,
                'to' => $next,
            ]);
        }

        DB::transaction(function () use ($assignment, $next) {
            DB::table('assignments')
                ->where('id', $assignment->id)
                ->update([
                    'status' => $next,
                    'updated_at' => now(),
                ]);

            DB::table('installation_requests')
                ->where('id', $assignment->installation_request_id)
                ->update([
                    'status' => $next,
                    'updated_at' => now(),
                ]);
        });

        return $this->success(['status' => $next]);
    }

    public function technicians(): JsonResponse
    {
        $technicians = User::query()
            ->where('role', User::ROLE_TECHNICIAN)
            ->select(['id', 'name', 'email'])
            ->orderBy('name')
            ->get();

        return $this->success(['items' => $technicians]);
    }

    public function stats(): JsonResponse
    {
        $pendingRequests = DB::table('installation_requests')->where('status', 'pending')->count();
        $assignments = DB::table('assignments')
            ->select('status', DB::raw('count(*) as total'))
            ->groupBy('status')
            ->get();
        $technicians = User::query()->where('role', User::ROLE_TECHNICIAN)->count();

        return $this->success([
            'pending_requests' => $pendingRequests,
            'assignments' => $assignments,
            'technicians' => $technicians,
        ]);
    }

    private function success(array $data = [], int $status = 200): JsonResponse
    {
        return response()->json([
            'success' => true,
            'data' => $data,
            'error' => null,
        ], $status);
    }

    private function error(string $message, int $status = 400, array $meta = []): JsonResponse
    {
        return response()->json([
            'success' => false,
            'data' => null,
            'error' => array_merge([
                'message' => $message,
            ], $meta),
        ], $status);
    }
}
