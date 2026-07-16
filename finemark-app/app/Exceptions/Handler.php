<?php

namespace App\Exceptions;

use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Foundation\Exceptions\Handler as ExceptionHandler;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Routing\Exceptions\ThrottleRequestsException;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

class Handler extends ExceptionHandler
{
    /**
     * The list of the inputs that are never flashed to the session on validation exceptions.
     *
     * @var array<int, string>
     */
    protected $dontFlash = [
        'current_password',
        'password',
        'password_confirmation',
    ];

    /**
     * Register the exception handling callbacks for the application.
     */
    public function register(): void
    {
        $this->reportable(function (Throwable $e) {
            //
        });
    }

    public function render($request, Throwable $e): Response
    {
        if ($request->expectsJson()) {
            if ($e instanceof AuthenticationException) {
                return $this->apiError('Unauthenticated.', 401);
            }

            if ($e instanceof AuthorizationException) {
                return $this->apiError($e->getMessage() ?: 'Forbidden.', 403);
            }

            if ($e instanceof ThrottleRequestsException) {
                return $this->apiError('Too many attempts. Please try again later.', 429);
            }
        }

        return parent::render($request, $e);
    }

    private function apiError(string $message, int $status): JsonResponse
    {
        return response()->json([
            'success' => false,
            'data' => null,
            'error' => [
                'message' => $message,
            ],
        ], $status);
    }
}
