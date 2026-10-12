import { Component, OnInit, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";

@Component({ selector: "app-profile", standalone: true, template: "<p>profile</p>" })
export class ProfileComponent implements OnInit {
  private readonly http = inject(HttpClient);
  ngOnInit() {
    this.http.get("/api/profile").subscribe();
  }
}
export default ProfileComponent;
