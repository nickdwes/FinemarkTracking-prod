<?php

use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Mobile Routes
|--------------------------------------------------------------------------
|
| Routes intended for mobile clients. Apply auth or versioning as needed.
|
*/

Route::get('/health', function () {
    return response()->json(['status' => 'ok']);
});
