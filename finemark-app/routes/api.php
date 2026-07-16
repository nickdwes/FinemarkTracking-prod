<?php

use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\TechnicalController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| API Routes
|--------------------------------------------------------------------------
|
| Here is where you can register API routes for your application. These
| routes are loaded by the RouteServiceProvider and all of them will
| be assigned to the "api" middleware group. Make something great!
|
*/

Route::middleware('auth:sanctum')->get('/user', function (Request $request) {
    return $request->user();
});

Route::prefix('auth')->group(function () {
    Route::post('/login', [AuthController::class, 'login'])->middleware('throttle:login');
    Route::post('/logout', [AuthController::class, 'logout'])->middleware('auth:sanctum');
    Route::post('/refresh', [AuthController::class, 'refresh'])->middleware('auth:sanctum');
    Route::post('/forgot-password', [AuthController::class, 'forgotPassword']);
    Route::post('/reset-password', [AuthController::class, 'resetPassword']);
});

Route::post('/verify-otp', [AuthController::class, 'verifyOtp'])->middleware('throttle:otp');
Route::post('/2fa/enable', [AuthController::class, 'enableTwoFactor'])->middleware('auth:sanctum');
Route::post('/2fa/disable', [AuthController::class, 'disableTwoFactor'])->middleware('auth:sanctum');

Route::middleware(['auth:sanctum', 'role:technical_officer,super_admin'])->prefix('technical')->group(function () {
    Route::get('/pending-requests', [TechnicalController::class, 'pendingRequests']);
    Route::get('/assignments', [TechnicalController::class, 'assignments']);
    Route::post('/assign/{requestId}', [TechnicalController::class, 'assign']);
    Route::put('/update-status/{assignmentId}', [TechnicalController::class, 'updateStatus']);
    Route::get('/technicians', [TechnicalController::class, 'technicians']);
    Route::get('/stats', [TechnicalController::class, 'stats']);
});
