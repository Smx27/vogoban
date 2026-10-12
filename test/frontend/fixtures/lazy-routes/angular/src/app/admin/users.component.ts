import { Component, OnInit, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";

@Component({ selector: "app-users", standalone: true, template: "<p>users</p>" })
export class UsersComponent implements OnInit {
  private readonly http = inject(HttpClient);
  ngOnInit() {
    this.http.get("/api/admin/users").subscribe();
  }
}
