<?php

namespace App\Http\Controllers\Web;

use App\Http\Controllers\Controller;
use Inertia\Inertia;
use Inertia\Response;

class TechnicalController extends Controller
{
    public function pendingRequests(): Response
    {
        return Inertia::render('Technical/PendingRequests');
    }

    public function assignmentForm(): Response
    {
        return Inertia::render('Technical/AssignmentForm');
    }

    public function assignments(): Response
    {
        return Inertia::render('Technical/Assignments');
    }
}
